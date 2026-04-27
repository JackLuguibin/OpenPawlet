"""FastAPI application factory and lifecycle management.

This module is the single entry point for the consolidated OpenPawlet
console.  In addition to the historical REST API + SPA hosting it now
also owns the embedded nanobot runtime (agent loop, channels, cron,
heartbeat) via :mod:`nanobot.runtime.embedded`, the OpenAI-compatible
``/v1/*`` surface and the ``/queues/*`` admin endpoints.  External
clients therefore only ever need to talk to one HTTP port.
"""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import websockets
import websockets.exceptions
from fastapi import FastAPI, HTTPException, Request, WebSocket, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from loguru import logger

from console.server.config import ServerSettings, get_settings
from console.server.models import ErrorDetail, ErrorResponse
from console.server.openai_api import install_openai_routes
from console.server.queue_envelope import tag_inbound_text_frame
from console.server.queues_router import install_queues_routes
from console.server.routers import v1
from console.server.state_hub import bind_state_hub_to_loop
from console.server.ws_state import state_ws_handler

_ERR_VALIDATION_CODE = "VALIDATION_ERROR"
_ERR_VALIDATION_MSG = "Request validation failed"
_ERR_INTERNAL_CODE = "INTERNAL_ERROR"
_ERR_INTERNAL_MSG = "An unexpected error occurred"

# Truthy environment-variable values, normalized to lowercase. Mirrors what
# the nanobot CLI accepts so console env flags behave the same way.
_TRUTHY_ENV_VALUES = frozenset({"1", "true", "yes", "on"})

_EMBEDDED_DISABLE_ENV = "OPENPAWLET_DISABLE_EMBEDDED"


def _env_flag(name: str, default: bool = False) -> bool:
    """Return True when ``$NAME`` is set to a truthy value."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in _TRUTHY_ENV_VALUES


def _embedded_disabled() -> bool:
    """Return True when the embedded nanobot runtime should not be started.

    Tests use this escape hatch to mount the FastAPI app without paying
    the cost of constructing the full agent + channels graph.
    """
    return _env_flag(_EMBEDDED_DISABLE_ENV)


async def _start_embedded_runtime(app: FastAPI) -> Any | None:
    """Construct and start the embedded nanobot runtime.

    Returns the ``EmbeddedNanobot`` on success, or ``None`` if the runtime
    could not be built or failed to start.  Either failure mode is logged
    and leaves the FastAPI app in degraded mode (HTTP keeps serving so the
    UI can still surface errors to the operator).
    """
    try:
        from console.server.nanobot_user_config import (
            ensure_full_config,
            resolve_config_path,
        )
        from nanobot.config.loader import set_config_path as _set_nanobot_config_path
        from nanobot.runtime.agent_manager import UnifiedAgentManager
        from nanobot.runtime.embedded import EmbeddedNanobot

        settings: ServerSettings = app.state.settings

        # When the console has an "active" non-default bot, retarget the
        # nanobot config loader at its per-bot config.json before
        # constructing the runtime.  Falling back to the default keeps
        # single-bot installs untouched.
        active_bot_id = getattr(app.state, "active_bot_id", None)
        if active_bot_id:
            from console.server.bots_registry import DEFAULT_BOT_ID, get_registry

            if active_bot_id != DEFAULT_BOT_ID:
                row = get_registry().get(active_bot_id)
                if row is not None:
                    _set_nanobot_config_path(Path(str(row["config_path"])))

        # Auto-fill any newly-introduced fields in the active bot's
        # ``config.json`` so users on freshly upgraded builds don't need to
        # hand-edit their files to pick up new defaults.  Failures are
        # logged inside ``ensure_full_config`` and never block startup.
        try:
            ensure_full_config(resolve_config_path(active_bot_id))
        except Exception:  # noqa: BLE001 - never block runtime over auto-fill
            logger.exception("[config] auto-fill of nanobot config failed; continuing")

        embedded = EmbeddedNanobot.from_environment(
            websocket_host=settings.nanobot_gateway_host,
            websocket_port=settings.nanobot_gateway_port,
            websocket_path="/",
            websocket_requires_token=False,
        )
    except Exception:  # noqa: BLE001 - degraded mode keeps the UI usable
        logger.exception(
            "Failed to construct embedded nanobot runtime; console will start in degraded mode"
        )
        return None

    try:
        await embedded.start()
    except Exception:  # noqa: BLE001 - keep API alive even if runtime fails
        logger.exception("Embedded nanobot runtime failed to start; degraded mode")
        return None

    app.state.embedded = embedded
    app.state.agent_loop = embedded.agent
    app.state.message_bus = embedded.message_bus
    app.state.session_manager = embedded.session_manager
    app.state.model_name = embedded.agent.model
    app.state.agent_manager = UnifiedAgentManager(embedded)
    return embedded


async def swap_runtime(app: FastAPI, bot_id: str) -> bool:
    """Stop the current embedded runtime and start a fresh one for *bot_id*.

    The console runs at most one runtime at a time (per-bot pooling
    requires multiple WebSocketChannel ports / cron stores; we use a
    main-vs-standby model for now to avoid that complexity).  Callers
    should treat this as a brief restart: in-flight WS connections are
    closed and any subagent state on the previous runtime is discarded.

    Returns ``True`` when the new runtime started, ``False`` when the
    swap left the app in degraded mode.
    """
    lock: asyncio.Lock = getattr(app.state, "runtime_swap_lock", None) or asyncio.Lock()
    app.state.runtime_swap_lock = lock
    async with lock:
        previous = getattr(app.state, "embedded", None)
        if previous is not None:
            try:
                await previous.stop()
            except Exception:  # pragma: no cover - best-effort teardown
                logger.exception("previous embedded runtime stop failed")
        for attr in ("embedded", "agent_loop", "message_bus", "session_manager", "agent_manager"):
            if hasattr(app.state, attr):
                delattr(app.state, attr)
        app.state.active_bot_id = bot_id
        new_runtime = await _start_embedded_runtime(app)
        return new_runtime is not None


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Bring the embedded nanobot runtime up alongside the HTTP server."""
    settings: ServerSettings = app.state.settings
    logger.info(
        "Starting OpenPawlet console server {version} - listening on {host}:{port}",
        version=settings.version,
        host=settings.host,
        port=settings.port,
    )
    app.state.started_at_perf = time.perf_counter()
    # Bind the state-push hub to this loop so synchronous publishers
    # (request handlers, agent worker threads) can enqueue frames.
    bind_state_hub_to_loop(asyncio.get_running_loop())
    # Track which bot the active runtime belongs to so the bots router
    # can refuse redundant ``/activate`` calls and surface accurate
    # per-bot status to the SPA.
    if not hasattr(app.state, "active_bot_id"):
        from console.server.bots_registry import get_registry

        try:
            app.state.active_bot_id = get_registry().default_id()
        except Exception:  # pragma: no cover - registry should not raise
            app.state.active_bot_id = "default"

    # Auto-fill any newly-introduced fields in ``nanobot_web.json`` once per
    # boot. Done here (not in ``create_app``) so test setups that build the
    # app without a real lifespan don't accidentally touch the user's home
    # directory.
    try:
        from console.server.config import ensure_server_config

        ensure_server_config()
    except Exception:  # noqa: BLE001 - server settings already resolved above
        logger.exception("[config] auto-fill of nanobot_web.json failed; continuing")

    if not _embedded_disabled():
        await _start_embedded_runtime(app)

    try:
        yield
    finally:
        embedded = getattr(app.state, "embedded", None)
        if embedded is not None:
            try:
                await embedded.stop()
            except Exception:  # pragma: no cover - best effort shutdown
                logger.exception("Embedded nanobot runtime shutdown failed")
        logger.info("Shutting down OpenPawlet console server")


def _error_json(
    status_code: int,
    *,
    code: str,
    message: str,
    detail: dict[str, Any] | None = None,
) -> JSONResponse:
    """Serialize the standard error envelope to JSON."""
    return JSONResponse(
        status_code=status_code,
        content=ErrorResponse(
            error=ErrorDetail(code=code, message=message, detail=detail)
        ).model_dump(mode="json"),
    )


_HTTP_STATUS_CODE_MAP: dict[int, str] = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    409: "CONFLICT",
    410: "GONE",
    413: "PAYLOAD_TOO_LARGE",
    415: "UNSUPPORTED_MEDIA_TYPE",
    422: "VALIDATION_ERROR",
    429: "RATE_LIMITED",
    500: "INTERNAL_ERROR",
    501: "NOT_IMPLEMENTED",
    503: "SERVICE_UNAVAILABLE",
    504: "GATEWAY_TIMEOUT",
}


def _is_openai_compat_path(request: Request) -> bool:
    """OpenAI-compatible routes keep their own error envelope.

    External clients expect the ``{error: {message, type, code}}`` shape
    documented by OpenAI; rewriting it would break SDKs.
    """
    return request.url.path.startswith("/v1/")


async def validation_exception_handler(
    request: Request,
    exc: RequestValidationError,
) -> JSONResponse:
    """422 for request body / parameter validation failures."""
    if _is_openai_compat_path(request):
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={
                "error": {
                    "message": _ERR_VALIDATION_MSG,
                    "type": "invalid_request_error",
                    "code": status.HTTP_422_UNPROCESSABLE_ENTITY,
                }
            },
        )
    return _error_json(
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        code=_ERR_VALIDATION_CODE,
        message=_ERR_VALIDATION_MSG,
        detail={"errors": exc.errors()},
    )


async def http_exception_handler(
    request: Request,
    exc: HTTPException,
) -> JSONResponse:
    """Wrap ``HTTPException`` in the standard ``ErrorResponse`` envelope.

    Without this, FastAPI emits ``{detail: "..."}`` and the front-end
    has to special-case both shapes; centralising the wrapping ensures
    every console error follows the same contract.  OpenAI compat paths
    are passed through their own format below.
    """
    code = _HTTP_STATUS_CODE_MAP.get(exc.status_code, f"HTTP_{exc.status_code}")
    detail = exc.detail
    if _is_openai_compat_path(request):
        msg = detail if isinstance(detail, str) else "Request failed"
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": {
                    "message": msg,
                    "type": "invalid_request_error",
                    "code": exc.status_code,
                }
            },
        )
    if isinstance(detail, str):
        message = detail
        detail_payload: dict[str, Any] | None = None
    else:
        message = code.replace("_", " ").title()
        detail_payload = {"detail": detail}
    return _error_json(
        exc.status_code,
        code=code,
        message=message,
        detail=detail_payload,
    )


async def unhandled_exception_handler(
    request: Request,
    _exc: Exception,
) -> JSONResponse:
    """500 for uncaught exceptions."""
    logger.exception("Unhandled exception")
    if _is_openai_compat_path(request):
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "error": {
                    "message": _ERR_INTERNAL_MSG,
                    "type": "server_error",
                    "code": status.HTTP_500_INTERNAL_SERVER_ERROR,
                }
            },
        )
    return _error_json(
        status.HTTP_500_INTERNAL_SERVER_ERROR,
        code=_ERR_INTERNAL_CODE,
        message=_ERR_INTERNAL_MSG,
    )


def _spa_dist_dir() -> Path:
    """Return the path to the bundled SPA ``dist`` directory."""
    return Path(__file__).resolve().parents[1] / "web" / "dist"


def _mount_spa(app: FastAPI) -> bool:
    """Mount the prebuilt SPA on ``app``. Returns True when assets were found."""
    dist = _spa_dist_dir()
    index = dist / "index.html"
    if not index.is_file():
        logger.warning(
            "[spa] dist not found at {}; run 'npm --prefix src/console/web run build' first.",
            dist,
        )
        return False

    assets_dir = dist / "assets"
    if assets_dir.is_dir():
        app.mount(
            "/assets",
            StaticFiles(directory=assets_dir),
            name="spa-assets",
        )

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str) -> FileResponse:
        if full_path:
            candidate = (dist / full_path).resolve()
            try:
                candidate.relative_to(dist)
            except ValueError:
                return FileResponse(index)
            if candidate.is_file():
                return FileResponse(candidate)
        return FileResponse(index)

    logger.info("[spa] SPA mounted from {}", dist)
    return True


def _ws_close_label(exc: BaseException) -> str:
    """Compact human-readable tag for a websockets ``ConnectionClosed``."""
    code = getattr(exc, "code", None)
    reason = getattr(exc, "reason", "") or ""
    if code is None:
        return type(exc).__name__
    return f"code={code} reason={reason!r}" if reason else f"code={code}"


async def _safe_ws_close(websocket: WebSocket, code: int = 1000) -> None:
    """Close *websocket* swallowing any error.

    Used during proxy teardown where the underlying transport may already
    be torn down; we never want close failures to mask the original cause.
    """
    try:
        await websocket.close(code=code)
    except Exception:  # pragma: no cover - best-effort cleanup
        pass


# WebSocket reverse-proxy hardening knobs.  The values are intentionally
# generous for legitimate UI use but cap obvious abuse; tighten via
# ``app.state.ws_limits`` if your channel needs different ceilings.
_WS_MAX_TEXT_BYTES = 64 * 1024
_WS_MAX_BINARY_BYTES = 256 * 1024
_WS_MAX_FRAMES_PER_S = 100
_WS_MAX_BYTES_PER_S = 1 * 1024 * 1024
# Forwarded query keys for the nanobot WS handshake. ``client_id`` and ``chat_id``
# are critical: the embedded nanobot ``WebSocketChannel`` uses them to identify
# the sender (allow_from check) and to resume the right per-chat ``chat_id`` so
# follow-up messages append to the same ``sessions/<key>.jsonl`` file. Without
# them the gateway falls back to ``anon-...`` + a freshly generated UUID, which
# manifests as "a brand-new session is created on every send" in the console UI.
_WS_QUERY_ALLOWLIST = frozenset({"session_id", "token", "client_id", "chat_id"})

# WebSocket close codes used by the proxy.
_WS_CLOSE_POLICY_VIOLATION = 1008
_WS_CLOSE_TOO_BIG = 1009


def _origin_is_allowed(origin: str | None, cors_origins: list[str]) -> bool:
    """True if *origin* is permitted to open a /nanobot-ws/* connection.

    Same-origin browser clients always pass; non-browser tools (which omit
    Origin) are also accepted because the underlying console has no auth
    today and the original protocol contract did not require it.  When a
    wildcard CORS rule is configured we honour it for parity with the
    HTTP surface.
    """
    if origin is None or origin == "":
        return True
    if any(o.strip() == "*" for o in cors_origins):
        return True
    return any(origin == o.strip() for o in cors_origins)


def _filter_query_string(raw: bytes | str) -> str:
    """Drop unknown query keys so callers cannot smuggle channel options."""
    if isinstance(raw, bytes):
        decoded = raw.decode("utf-8", errors="replace")
    else:
        decoded = str(raw)
    if not decoded:
        return ""
    kept: list[str] = []
    for chunk in decoded.split("&"):
        if not chunk:
            continue
        key = chunk.split("=", 1)[0]
        if key in _WS_QUERY_ALLOWLIST:
            kept.append(chunk)
    return "&".join(kept)


class _RateLimiter:
    """Simple frame + byte rate limiter using a 1s sliding window.

    Updated by the proxy reader on every inbound frame; ``allow`` returns
    False once the per-second ceilings are crossed so the caller can close
    the connection with 1008.
    """

    def __init__(self, max_frames: int, max_bytes: int) -> None:
        self._max_frames = max_frames
        self._max_bytes = max_bytes
        self._window_start = 0.0
        self._frames = 0
        self._bytes = 0

    def allow(self, frame_bytes: int) -> bool:
        now = time.monotonic()
        if now - self._window_start >= 1.0:
            self._window_start = now
            self._frames = 0
            self._bytes = 0
        self._frames += 1
        self._bytes += frame_bytes
        return self._frames <= self._max_frames and self._bytes <= self._max_bytes


async def _nanobot_ws_proxy(
    websocket: WebSocket,
    rest_path: str,
    gateway_host: str,
    gateway_port: int,
    cors_origins: list[str],
) -> None:
    """Bidirectionally proxy a WebSocket connection to the in-process nanobot WS channel.

    The embedded ``WebSocketChannel`` listens on a loopback port inside
    the same process and event loop, so this is a same-origin hop rather
    than a cross-process round trip.  We enforce origin/query/frame-size
    restrictions before forwarding anything because the upstream channel
    is implicitly trusted.
    """
    headers = {k.decode().lower(): v.decode() for k, v in websocket.scope.get("headers", [])}
    origin = headers.get("origin")
    if not _origin_is_allowed(origin, cors_origins):
        logger.warning("[nanobot-ws-proxy] reject origin={!r}", origin)
        await websocket.close(code=_WS_CLOSE_POLICY_VIOLATION)
        return

    await websocket.accept()

    query_string = _filter_query_string(websocket.scope.get("query_string", b""))
    target_path = f"/{rest_path}" if rest_path else "/"
    target_url = f"ws://{gateway_host}:{gateway_port}{target_path}"
    if query_string:
        target_url = f"{target_url}?{query_string}"

    client_addr = websocket.client
    logger.debug(
        "[nanobot-ws-proxy] open client={} -> {}:{}{}",
        client_addr,
        gateway_host,
        gateway_port,
        target_path,
    )

    rate_limiter = _RateLimiter(_WS_MAX_FRAMES_PER_S, _WS_MAX_BYTES_PER_S)

    try:
        async with websockets.connect(target_url) as remote_ws:

            async def _client_to_remote() -> None:
                try:
                    while True:
                        frame = await websocket.receive()
                        if frame.get("type") == "websocket.disconnect":
                            break
                        text = frame.get("text")
                        data = frame.get("bytes")
                        if text is not None:
                            text_bytes = len(text.encode("utf-8", errors="replace"))
                            if text_bytes > _WS_MAX_TEXT_BYTES:
                                logger.warning(
                                    "[nanobot-ws-proxy] text frame {} > {} bytes; closing",
                                    text_bytes,
                                    _WS_MAX_TEXT_BYTES,
                                )
                                await websocket.close(code=_WS_CLOSE_TOO_BIG)
                                break
                            if not rate_limiter.allow(text_bytes):
                                logger.warning("[nanobot-ws-proxy] rate-limit hit; closing")
                                await websocket.close(code=_WS_CLOSE_POLICY_VIOLATION)
                                break
                            tagged = tag_inbound_text_frame(text)
                            await remote_ws.send(tagged)
                        elif data is not None:
                            if len(data) > _WS_MAX_BINARY_BYTES:
                                logger.warning(
                                    "[nanobot-ws-proxy] binary frame {} > {} bytes; closing",
                                    len(data),
                                    _WS_MAX_BINARY_BYTES,
                                )
                                await websocket.close(code=_WS_CLOSE_TOO_BIG)
                                break
                            if not rate_limiter.allow(len(data)):
                                logger.warning("[nanobot-ws-proxy] rate-limit hit; closing")
                                await websocket.close(code=_WS_CLOSE_POLICY_VIOLATION)
                                break
                            await remote_ws.send(data)
                except websockets.exceptions.ConnectionClosed:
                    pass
                except Exception as exc:  # noqa: BLE001 - close both sides
                    logger.warning("[nanobot-ws-proxy] client->gateway error: {}", exc)
                finally:
                    await remote_ws.close()

            async def _remote_to_client() -> None:
                try:
                    async for message in remote_ws:
                        if isinstance(message, str):
                            await websocket.send_text(message)
                        else:
                            await websocket.send_bytes(message)
                except websockets.exceptions.ConnectionClosed:
                    pass
                except Exception as exc:  # noqa: BLE001
                    logger.warning("[nanobot-ws-proxy] gateway->client error: {}", exc)
                finally:
                    await _safe_ws_close(websocket)

            tasks = [
                asyncio.create_task(_client_to_remote()),
                asyncio.create_task(_remote_to_client()),
            ]
            _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                except Exception:  # pragma: no cover
                    pass

    except OSError as exc:
        logger.warning(
            "[nanobot-ws-proxy] cannot reach embedded gateway at ws://{}:{}{}: {}",
            gateway_host,
            gateway_port,
            target_path,
            exc,
        )
        await _safe_ws_close(websocket, code=1014)
    except Exception as exc:  # noqa: BLE001
        logger.exception("[nanobot-ws-proxy] unexpected proxy error: {}", exc)
        await _safe_ws_close(websocket, code=1011)


def _mount_nanobot_ws_proxy(
    app: FastAPI,
    gateway_host: str,
    gateway_port: int,
    cors_origins: list[str],
) -> None:
    """Register the ``/nanobot-ws/`` WebSocket reverse-proxy route on *app*."""

    @app.websocket("/nanobot-ws/{rest_path:path}")
    async def nanobot_ws_proxy_route(websocket: WebSocket, rest_path: str) -> None:
        await _nanobot_ws_proxy(
            websocket,
            rest_path,
            gateway_host,
            gateway_port,
            cors_origins,
        )

    logger.info(
        "[nanobot-ws-proxy] Proxying /nanobot-ws/* -> ws://{}:{} (in-process loopback)",
        gateway_host,
        gateway_port,
    )


def create_app(
    settings: ServerSettings | None = None,
    *,
    mount_spa: bool = False,
) -> FastAPI:
    """Build and return a fully-configured FastAPI application instance.

    Args:
        settings: Optional pre-built settings object. If omitted the
            singleton from ``get_settings()`` is used.
        mount_spa: When True, serve the prebuilt SPA from
            ``src/console/web/dist`` and skip the JSON service-info root.
    """
    if settings is None:
        settings = get_settings()

    app = FastAPI(
        title=settings.title,
        description=settings.description,
        version=settings.version,
        lifespan=lifespan,
        docs_url=settings.effective_docs_url,
        redoc_url=settings.effective_redoc_url,
        openapi_url=settings.effective_openapi_url,
    )
    app.state.settings = settings
    app.state.started_at_perf = time.perf_counter()

    _wildcard_cors = any(o.strip() == "*" for o in settings.cors_origins)
    allow_credentials = settings.cors_allow_credentials and not _wildcard_cors
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=allow_credentials,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(v1.api_router, prefix=settings.api_prefix)
    install_openai_routes(app, model_name="nanobot")
    install_queues_routes(app)

    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(HTTPException, http_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)

    # Register WS proxy before the SPA catch-all so the path isn't swallowed.
    # The "gateway" now lives in the same process via EmbeddedNanobot, but the
    # underlying WebSocketChannel still binds a loopback port for protocol
    # fidelity, so we proxy same-origin to it.
    _mount_nanobot_ws_proxy(
        app,
        settings.nanobot_gateway_host,
        settings.nanobot_gateway_port,
        list(settings.cors_origins),
    )

    # Server-driven state push channel.  Mounted before the SPA fallback so
    # the path is not swallowed by the catch-all.  See ``state_hub.py``
    # and ``ws_state.py`` for the protocol contract.
    @app.websocket("/ws/state")
    async def _ws_state_route(websocket: WebSocket) -> None:
        await state_ws_handler(websocket)

    spa_mounted = _mount_spa(app) if mount_spa else False

    if not spa_mounted:

        @app.get("/", include_in_schema=False)
        async def root() -> dict[str, str]:
            return {"service": settings.title, "version": settings.version}

    return app
