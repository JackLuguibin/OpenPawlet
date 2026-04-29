"""Same-origin WebSocket reverse-proxy for the embedded OpenPawlet gateway.

The embedded ``WebSocketChannel`` listens on a loopback port inside this
process; the SPA still talks to it via ``/openpawlet-ws/*`` so cookies, CORS
and request logging stay attached to the FastAPI surface.  This module
owns the hardening (origin allowlist, query-key allowlist, frame size
caps, simple sliding-window rate limiter) so ``app.py`` stays focused on
wiring.
"""

from __future__ import annotations

import asyncio
import contextlib
import time

import websockets
import websockets.exceptions
from fastapi import FastAPI, WebSocket
from loguru import logger

from console.server.queue_envelope import tag_inbound_text_frame

# WebSocket reverse-proxy hardening knobs.  The values are intentionally
# generous for legitimate UI use but cap obvious abuse.
_WS_MAX_TEXT_BYTES = 64 * 1024
_WS_MAX_BINARY_BYTES = 256 * 1024
_WS_MAX_FRAMES_PER_S = 100
_WS_MAX_BYTES_PER_S = 1 * 1024 * 1024

# Forwarded query keys for the OpenPawlet WS handshake.  ``client_id`` and
# ``chat_id`` are critical: the embedded ``WebSocketChannel`` uses them to
# identify the sender (allow_from check) and to resume the right per-chat
# ``chat_id`` so follow-up messages append to the same
# ``sessions/<key>.jsonl`` file.  Without them the gateway falls back to
# ``anon-...`` + a freshly generated UUID, which manifests as "a brand-new
# session is created on every send" in the console UI.
_WS_QUERY_ALLOWLIST = frozenset({"session_id", "token", "client_id", "chat_id"})

_WS_CLOSE_POLICY_VIOLATION = 1008
_WS_CLOSE_TOO_BIG = 1009


def _origin_is_allowed(origin: str | None, cors_origins: list[str]) -> bool:
    """True if *origin* may open a /openpawlet-ws/* connection."""
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


async def _safe_ws_close(websocket: WebSocket, code: int = 1000) -> None:
    """Close *websocket* swallowing any error (best-effort cleanup)."""
    with contextlib.suppress(Exception):  # pragma: no cover - best-effort cleanup
        await websocket.close(code=code)


class _RateLimiter:
    """Simple frame + byte rate limiter using a 1s sliding window."""

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


async def _pump_client_to_remote(
    websocket: WebSocket,
    remote_ws: websockets.WebSocketClientProtocol,
    rate_limiter: _RateLimiter,
) -> None:
    """Forward client frames to the embedded gateway with size + rate caps."""
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
                        "[openpawlet-ws-proxy] text frame {} > {} bytes; closing",
                        text_bytes,
                        _WS_MAX_TEXT_BYTES,
                    )
                    await websocket.close(code=_WS_CLOSE_TOO_BIG)
                    break
                if not rate_limiter.allow(text_bytes):
                    logger.warning("[openpawlet-ws-proxy] rate-limit hit; closing")
                    await websocket.close(code=_WS_CLOSE_POLICY_VIOLATION)
                    break
                await remote_ws.send(tag_inbound_text_frame(text))
            elif data is not None:
                if len(data) > _WS_MAX_BINARY_BYTES:
                    logger.warning(
                        "[openpawlet-ws-proxy] binary frame {} > {} bytes; closing",
                        len(data),
                        _WS_MAX_BINARY_BYTES,
                    )
                    await websocket.close(code=_WS_CLOSE_TOO_BIG)
                    break
                if not rate_limiter.allow(len(data)):
                    logger.warning("[openpawlet-ws-proxy] rate-limit hit; closing")
                    await websocket.close(code=_WS_CLOSE_POLICY_VIOLATION)
                    break
                await remote_ws.send(data)
    except websockets.exceptions.ConnectionClosed:
        logger.debug("[openpawlet-ws-proxy] client->gateway: peer closed")
    except Exception as exc:  # noqa: BLE001 - close both sides
        logger.warning("[openpawlet-ws-proxy] client->gateway error: {}", exc)
    finally:
        await remote_ws.close()


async def _pump_remote_to_client(
    websocket: WebSocket,
    remote_ws: websockets.WebSocketClientProtocol,
) -> None:
    """Forward gateway frames back to the browser client."""
    try:
        async for message in remote_ws:
            if isinstance(message, str):
                await websocket.send_text(message)
            else:
                await websocket.send_bytes(message)
    except websockets.exceptions.ConnectionClosed:
        logger.debug("[openpawlet-ws-proxy] gateway->client: peer closed")
    except Exception as exc:  # noqa: BLE001
        logger.warning("[openpawlet-ws-proxy] gateway->client error: {}", exc)
    finally:
        await _safe_ws_close(websocket)


async def proxy_websocket(
    websocket: WebSocket,
    rest_path: str,
    gateway_host: str,
    gateway_port: int,
    cors_origins: list[str],
) -> None:
    """Bidirectionally proxy a WebSocket to the in-process OpenPawlet WS channel."""
    headers = {k.decode().lower(): v.decode() for k, v in websocket.scope.get("headers", [])}
    origin = headers.get("origin")
    if not _origin_is_allowed(origin, cors_origins):
        logger.warning("[openpawlet-ws-proxy] reject origin={!r}", origin)
        await websocket.close(code=_WS_CLOSE_POLICY_VIOLATION)
        return

    await websocket.accept()

    query_string = _filter_query_string(websocket.scope.get("query_string", b""))
    target_path = f"/{rest_path}" if rest_path else "/"
    target_url = f"ws://{gateway_host}:{gateway_port}{target_path}"
    if query_string:
        target_url = f"{target_url}?{query_string}"

    logger.debug(
        "[openpawlet-ws-proxy] open client={} -> {}:{}{}",
        websocket.client,
        gateway_host,
        gateway_port,
        target_path,
    )

    rate_limiter = _RateLimiter(_WS_MAX_FRAMES_PER_S, _WS_MAX_BYTES_PER_S)

    try:
        async with websockets.connect(target_url) as remote_ws:
            tasks = [
                asyncio.create_task(
                    _pump_client_to_remote(websocket, remote_ws, rate_limiter)
                ),
                asyncio.create_task(_pump_remote_to_client(websocket, remote_ws)),
            ]
            _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):  # pragma: no cover
                    await task

    except OSError as exc:
        logger.warning(
            "[openpawlet-ws-proxy] cannot reach embedded gateway at ws://{}:{}{}: {}",
            gateway_host,
            gateway_port,
            target_path,
            exc,
        )
        await _safe_ws_close(websocket, code=1014)
    except Exception as exc:  # noqa: BLE001
        logger.exception("[openpawlet-ws-proxy] unexpected proxy error: {}", exc)
        await _safe_ws_close(websocket, code=1011)


def mount_openpawlet_ws_proxy(
    app: FastAPI,
    gateway_host: str,
    gateway_port: int,
    cors_origins: list[str],
) -> None:
    """Register the ``/openpawlet-ws/`` WebSocket reverse-proxy route on *app*."""

    @app.websocket("/openpawlet-ws/{rest_path:path}")
    async def openpawlet_ws_proxy_route(websocket: WebSocket, rest_path: str) -> None:
        await proxy_websocket(
            websocket,
            rest_path,
            gateway_host,
            gateway_port,
            cors_origins,
        )

    logger.info(
        "[openpawlet-ws-proxy] Proxying /openpawlet-ws/* -> ws://{}:{} (in-process loopback)",
        gateway_host,
        gateway_port,
    )


__all__ = ["mount_openpawlet_ws_proxy", "proxy_websocket"]
