"""OpenAI-compatible chat completions API mounted on the console FastAPI app.

Provides ``/v1/chat/completions``, ``/v1/models`` and ``/v1/health`` against
the in-process :class:`~nanobot.agent.loop.AgentLoop` set on ``app.state``.

This module replaces the standalone ``nanobot serve`` HTTP service: the
console FastAPI process now hosts the OpenAI surface directly, so callers
talk to a single port instead of juggling separate gateway / API
processes.
"""

from __future__ import annotations

import asyncio
import base64
import json
import mimetypes
import re
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from loguru import logger

from nanobot.config.paths import get_media_dir
from nanobot.utils.helpers import safe_filename
from nanobot.utils.runtime import EMPTY_FINAL_RESPONSE_MESSAGE

MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB
_DATA_URL_RE = re.compile(r"^data:([^;]+);base64,(.+)$", re.DOTALL)

# Bound the per-session lock cache so attackers cannot OOM the process by
# rotating ``session_id`` values forever; entries idle beyond _LOCK_TTL_S
# are evicted opportunistically when new ones are inserted.
_LOCK_CACHE_MAX = 1024
_LOCK_TTL_S = 600.0
# Hard ceiling on concurrent /v1/chat/completions requests across all
# sessions; keeps the underlying provider client + MCP fan-out stable.
_DEFAULT_CONCURRENCY = 8


class _SessionLockCache:
    """TTL cache mapping session_key to ``asyncio.Lock``.

    ``setdefault``-style API but with bounded size and idle eviction; any
    lock that has been untouched for ``ttl_s`` seconds is dropped on the
    next insert path so the cache cannot grow unbounded on attacker input
    while still serialising real concurrent requests against the same
    session_key.
    """

    def __init__(self, max_size: int = _LOCK_CACHE_MAX, ttl_s: float = _LOCK_TTL_S) -> None:
        self._max_size = max_size
        self._ttl_s = ttl_s
        self._items: dict[str, tuple[asyncio.Lock, float]] = {}

    def get_or_create(self, key: str) -> asyncio.Lock:
        now = time.monotonic()
        existing = self._items.get(key)
        if existing is not None:
            lock, _ = existing
            self._items[key] = (lock, now)
            return lock
        self._evict(now)
        lock = asyncio.Lock()
        self._items[key] = (lock, now)
        return lock

    def _evict(self, now: float) -> None:
        # Drop expired idle entries first.
        cutoff = now - self._ttl_s
        for key in [k for k, (lock, ts) in self._items.items() if ts < cutoff and not lock.locked()]:
            self._items.pop(key, None)
        if len(self._items) < self._max_size:
            return
        # Still over capacity: shed the oldest unlocked entries.
        ordered = sorted(self._items.items(), key=lambda kv: kv[1][1])
        for key, (lock, _) in ordered:
            if len(self._items) < self._max_size:
                break
            if not lock.locked():
                self._items.pop(key, None)

    def __len__(self) -> int:
        return len(self._items)


class _FileSizeExceededError(Exception):
    """Raised when an uploaded file exceeds the size limit."""


API_SESSION_KEY = "api:default"
API_CHAT_ID = "default"


def _cleanup_media_files(paths: list[str]) -> None:
    """Best-effort removal of saved upload files when a request fails.

    We never want a half-processed multipart upload to leave the workspace
    media directory growing forever; missing/permission errors are logged
    at debug level only since the request is already failing.
    """
    for raw in paths:
        try:
            Path(raw).unlink(missing_ok=True)
        except OSError as exc:
            logger.debug("media cleanup failed {}: {}", raw, exc)


def _error_json(status: int, message: str, err_type: str = "invalid_request_error") -> JSONResponse:
    """Build an OpenAI-compatible error JSONResponse.

    Thin wrapper around :func:`error_handlers.openai_error_response` kept so
    the OpenAI router code stays at this short call shape.
    """
    from console.server.error_handlers import openai_error_response

    return openai_error_response(status, message, err_type=err_type)


def _chat_completion_response(content: str, model: str) -> dict[str, Any]:
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


def _response_text(value: Any) -> str:
    """Normalize ``process_direct`` output to plain assistant text."""
    if value is None:
        return ""
    if hasattr(value, "content"):
        return str(getattr(value, "content") or "")
    return str(value)


def _sse_chunk(delta: str, model: str, chunk_id: str, finish_reason: str | None = None) -> bytes:
    """Format a single OpenAI-compatible SSE chunk."""
    payload = {
        "id": chunk_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": {"content": delta} if delta else {},
                "finish_reason": finish_reason,
            }
        ],
    }
    return f"data: {json.dumps(payload)}\n\n".encode()


_SSE_DONE = b"data: [DONE]\n\n"


def _save_base64_data_url(data_url: str, media_dir: Path) -> str | None:
    """Decode a ``data:...;base64,...`` URL and save to disk."""
    m = _DATA_URL_RE.match(data_url)
    if not m:
        return None
    mime_type, b64_payload = m.group(1), m.group(2)
    try:
        raw = base64.b64decode(b64_payload)
    except Exception:
        return None
    if len(raw) > MAX_FILE_SIZE:
        raise _FileSizeExceededError(f"File exceeds {MAX_FILE_SIZE // (1024 * 1024)}MB limit")
    ext = mimetypes.guess_extension(mime_type) or ".bin"
    filename = f"{uuid.uuid4().hex[:12]}{ext}"
    dest = media_dir / safe_filename(filename)
    dest.write_bytes(raw)
    return str(dest)


def _parse_json_content(body: dict) -> tuple[str, list[str]]:
    """Parse JSON request body. Returns ``(text, media_paths)``."""
    messages = body.get("messages")
    if not isinstance(messages, list) or len(messages) != 1:
        raise ValueError("Only a single user message is supported")
    message = messages[0]
    if not isinstance(message, dict) or message.get("role") != "user":
        raise ValueError("Only a single user message is supported")

    user_content = message.get("content", "")
    media_dir = get_media_dir("api")
    media_paths: list[str] = []

    if isinstance(user_content, list):
        text_parts: list[str] = []
        for part in user_content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text":
                text_parts.append(part.get("text", ""))
            elif part.get("type") == "image_url":
                url = part.get("image_url", {}).get("url", "")
                if url.startswith("data:"):
                    saved = _save_base64_data_url(url, media_dir)
                    if saved:
                        media_paths.append(saved)
                elif url:
                    raise ValueError(
                        "Remote image URLs are not supported. "
                        "Use base64 data URLs or upload files via multipart/form-data."
                    )
        text = " ".join(text_parts)
    elif isinstance(user_content, str):
        text = user_content
    else:
        raise ValueError("Invalid content format")

    return text, media_paths


async def _parse_multipart(
    request: Request,
) -> tuple[str, list[str], str | None, str | None]:
    """Parse ``multipart/form-data``. Returns ``(text, media, session_id, model)``."""
    media_dir = get_media_dir("api")
    form = await request.form()
    text = str(form.get("message", "") or "")
    session_id: str | None = None
    model: str | None = None
    media_paths: list[str] = []

    _session = form.get("session_id")
    if _session is not None:
        session_id = str(_session).strip() or None
    _model = form.get("model")
    if _model is not None:
        model = str(_model).strip() or None

    for upload in form.getlist("files"):
        raw = await upload.read()
        if len(raw) > MAX_FILE_SIZE:
            raise _FileSizeExceededError(
                f"File '{upload.filename}' exceeds {MAX_FILE_SIZE // (1024 * 1024)}MB limit"
            )
        base = safe_filename(upload.filename or "upload.bin")
        filename = f"{uuid.uuid4().hex[:12]}_{base}"
        dest = media_dir / filename
        dest.write_bytes(raw)
        media_paths.append(str(dest))

    if not text:
        text = "请分析上传的文件"

    return text, media_paths, session_id, model


async def handle_chat_completions(request: Request) -> Response:
    """``POST /v1/chat/completions`` - supports JSON and multipart/form-data."""
    content_type = request.headers.get("content-type", "")
    if not isinstance(content_type, str):
        content_type = ""

    agent_loop = getattr(request.app.state, "agent_loop", None)
    if agent_loop is None:
        return _error_json(503, "agent runtime not ready", err_type="server_error")
    timeout_s: float = float(getattr(request.app.state, "request_timeout", 120.0))
    model_name: str = str(getattr(request.app.state, "model_name", "nanobot"))

    stream = False
    try:
        if content_type.startswith("multipart/"):
            text, media_paths, session_id, requested_model = await _parse_multipart(request)
        else:
            try:
                body = await request.json()
            except Exception:
                return _error_json(400, "Invalid JSON body")
            stream = bool(body.get("stream", False))
            requested_model = body.get("model")
            text, media_paths = _parse_json_content(body)
            session_id = body.get("session_id")
    except ValueError as exc:
        return _error_json(400, str(exc))
    except _FileSizeExceededError as exc:
        return _error_json(413, str(exc), err_type="invalid_request_error")
    except Exception:
        logger.exception("Error parsing upload")
        return _error_json(413, "File too large or invalid upload")

    if requested_model and requested_model != model_name:
        return _error_json(400, f"Only configured model '{model_name}' is available")

    session_key = f"api:{session_id}" if session_id else API_SESSION_KEY
    session_locks = request.app.state.openai_session_locks
    if isinstance(session_locks, _SessionLockCache):
        session_lock = session_locks.get_or_create(session_key)
    else:
        # Tests and other custom mounts may inject a plain dict; keep the
        # legacy ``setdefault`` semantics so they still serialise per
        # session_key without our TTL/eviction guarantees.
        session_lock = session_locks.setdefault(session_key, asyncio.Lock())
    concurrency_sem = getattr(request.app.state, "openai_concurrency_sem", None)
    if concurrency_sem is None:
        concurrency_sem = asyncio.Semaphore(_DEFAULT_CONCURRENCY)
        request.app.state.openai_concurrency_sem = concurrency_sem

    logger.info(
        "OpenAI API request session_key={} media={} text={} stream={}",
        session_key,
        len(media_paths),
        text[:80],
        stream,
    )
    if stream:
        chunk_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
        queue: asyncio.Queue[str | None] = asyncio.Queue()
        stream_failed = False

        async def _on_stream(token: str) -> None:
            await queue.put(token)

        async def _on_stream_end(*_a: Any, **_kw: Any) -> None:
            await queue.put(None)

        async def _run() -> None:
            nonlocal stream_failed
            try:
                async with concurrency_sem, session_lock:
                    await asyncio.wait_for(
                        agent_loop.process_direct(
                            content=text,
                            media=media_paths if media_paths else None,
                            session_key=session_key,
                            channel="api",
                            chat_id=API_CHAT_ID,
                            on_stream=_on_stream,
                            on_stream_end=_on_stream_end,
                        ),
                        timeout=timeout_s,
                    )
            except Exception:
                stream_failed = True
                _cleanup_media_files(media_paths)
                logger.exception("Streaming error for session {}", session_key)
            finally:
                # Ensure the stream terminates even when providers do not
                # invoke on_stream_end (common for non-streaming backends).
                await queue.put(None)

        async def _event_stream():
            task = asyncio.create_task(_run())
            try:
                while True:
                    token = await queue.get()
                    if token is None:
                        break
                    yield _sse_chunk(token, model_name, chunk_id)
            finally:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
            if not stream_failed:
                yield _sse_chunk("", model_name, chunk_id, finish_reason="stop")
                yield _SSE_DONE

        return StreamingResponse(
            _event_stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
        )

    fallback = EMPTY_FINAL_RESPONSE_MESSAGE
    try:
        async with concurrency_sem, session_lock:
            try:
                response = await asyncio.wait_for(
                    agent_loop.process_direct(
                        content=text,
                        media=media_paths if media_paths else None,
                        session_key=session_key,
                        channel="api",
                        chat_id=API_CHAT_ID,
                    ),
                    timeout=timeout_s,
                )
                response_text = _response_text(response)

                if not response_text or not response_text.strip():
                    logger.warning("Empty response for session {}, retrying", session_key)
                    retry_response = await asyncio.wait_for(
                        agent_loop.process_direct(
                            content=text,
                            media=media_paths if media_paths else None,
                            session_key=session_key,
                            channel="api",
                            chat_id=API_CHAT_ID,
                        ),
                        timeout=timeout_s,
                    )
                    response_text = _response_text(retry_response)
                    if not response_text or not response_text.strip():
                        logger.warning("Empty response after retry, using fallback")
                        response_text = fallback
            except TimeoutError:
                _cleanup_media_files(media_paths)
                return _error_json(504, f"Request timed out after {timeout_s}s")
            except Exception:
                _cleanup_media_files(media_paths)
                logger.exception("Error processing request for session {}", session_key)
                return _error_json(500, "Internal server error", err_type="server_error")
    except Exception:
        _cleanup_media_files(media_paths)
        logger.exception("Unexpected API lock error for session {}", session_key)
        return _error_json(500, "Internal server error", err_type="server_error")

    return JSONResponse(_chat_completion_response(response_text, model_name))


async def handle_models(request: Request) -> JSONResponse:
    """``GET /v1/models``."""
    model_name = str(getattr(request.app.state, "model_name", "nanobot"))
    return JSONResponse(
        {
            "object": "list",
            "data": [
                {
                    "id": model_name,
                    "object": "model",
                    "created": 0,
                    "owned_by": "nanobot",
                }
            ],
        }
    )


async def handle_health(_request: Request) -> JSONResponse:
    """``GET /v1/health``."""
    return JSONResponse({"status": "ok"})


def install_openai_routes(
    app: FastAPI,
    *,
    model_name: str = "nanobot",
    request_timeout: float = 120.0,
    max_concurrency: int = _DEFAULT_CONCURRENCY,
) -> APIRouter:
    """Install OpenAI-compatible routes on *app* and return the router.

    The caller must populate ``app.state.agent_loop`` (typically inside a
    FastAPI lifespan) before the first HTTP request is processed.
    """
    app.state.model_name = model_name
    app.state.request_timeout = request_timeout
    if not isinstance(getattr(app.state, "openai_session_locks", None), _SessionLockCache):
        app.state.openai_session_locks = _SessionLockCache()
    if not isinstance(getattr(app.state, "openai_concurrency_sem", None), asyncio.Semaphore):
        app.state.openai_concurrency_sem = asyncio.Semaphore(max(1, int(max_concurrency)))
    router = APIRouter()
    router.add_api_route("/v1/chat/completions", handle_chat_completions, methods=["POST"])
    router.add_api_route("/v1/models", handle_models, methods=["GET"])
    router.add_api_route("/v1/health", handle_health, methods=["GET"])
    # Backwards-compatible alias for the legacy ``/health`` path that the
    # standalone ``nanobot serve`` process used to expose at root level.
    router.add_api_route("/health", handle_health, methods=["GET"])
    app.include_router(router)
    return router


def create_app(agent_loop, model_name: str = "nanobot", request_timeout: float = 120.0) -> FastAPI:
    """Create a standalone FastAPI app (kept for backwards compatibility)."""
    app = FastAPI(title="nanobot-openai-api")
    app.state.agent_loop = agent_loop
    install_openai_routes(app, model_name=model_name, request_timeout=request_timeout)
    return app


__all__ = [
    "API_CHAT_ID",
    "API_SESSION_KEY",
    "MAX_FILE_SIZE",
    "create_app",
    "handle_chat_completions",
    "handle_health",
    "handle_models",
    "install_openai_routes",
]
