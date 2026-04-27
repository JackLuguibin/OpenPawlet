"""``/ws/state`` WebSocket endpoint for server-driven console state push.

This is the consumer side of :mod:`console.server.state_hub`.  The SPA
opens one connection per browser tab; the handler:

    * accepts the upgrade,
    * registers a per-connection subscriber against the hub,
    * on every inbound text frame parses ``{type}`` and routes:
        - ``subscribe`` / ``unsubscribe`` -> retarget the subscriber's
          ``bot_id`` filter and immediately push a fresh snapshot for
          the new scope so the SPA's caches don't show stale data
          across bot switches;
        - ``ping`` -> reply with ``pong`` (round-trip keepalive used by
          the SPA to detect dead connections without waiting for the
          underlying TCP close);
    * on every outbound frame from the hub queue, serialises and sends.

Closing semantics:
    * Any send/recv error closes the socket; the SPA reconnects with
      exponential backoff via ``useReconnectingWebSocket``.
    * The hub queue is drained on disconnect so an in-flight publish
      does not raise ``PutFull`` after the consumer is gone.

The endpoint is mounted at ``/ws/state`` (no API prefix) by
``console.server.app`` so the same path works in dev (Vite proxy) and
prod (SPA same-origin).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect
from loguru import logger

from console.server.state_hub import (
    SERVER_PING_INTERVAL_S,
    StateHub,
    get_state_hub,
)
from console.server.state_hub_helpers import (
    push_channels_snapshot,
    push_mcp_snapshot,
    push_sessions_snapshot,
    push_status_snapshot,
)

# Inbound frame size cap.  Subscribe frames are tiny (~80 bytes); 4 KiB
# leaves room for future fields without inviting abuse.
_MAX_INBOUND_TEXT_BYTES = 4 * 1024


async def state_ws_handler(websocket: WebSocket) -> None:
    """Per-connection lifecycle for ``/ws/state``."""
    hub = get_state_hub()
    # The lifespan handler binds the loop on startup; if a client races
    # the bind by connecting early we bind here to avoid dropping pushes.
    if hub.loop is None:
        try:
            hub.bind_loop(asyncio.get_running_loop())
        except RuntimeError:  # pragma: no cover - no running loop
            await websocket.close(code=1011)
            return

    await websocket.accept()

    initial_bot_id = _initial_bot_id_from_query(websocket)
    sub = await hub.register_subscriber(initial_bot_id)

    # Send a welcome immediately so the SPA can confirm the channel is
    # live before issuing its subscribe message.  Older browsers latch
    # ``readyState=OPEN`` before the handshake fully settles, so adding
    # a server-side ack avoids a race where the first ``subscribe``
    # would be sent before the handler is ready to receive it.
    await _safe_send_json(
        websocket,
        {
            "type": "welcome",
            "data": {
                "server_time": time.time(),
                "ping_interval": SERVER_PING_INTERVAL_S,
            },
        },
    )

    if initial_bot_id:
        # Push initial snapshots now so the SPA can hydrate without an
        # extra HTTP call.  Done in a background task so a slow
        # aggregator (e.g. dashboard_metrics scanning JSONL) does not
        # delay the main read/write loops.
        asyncio.create_task(_push_initial_snapshots(initial_bot_id))

    reader_task = asyncio.create_task(_reader_loop(websocket, hub, sub))
    writer_task = asyncio.create_task(_writer_loop(websocket, sub.queue))
    pinger_task = asyncio.create_task(_pinger_loop(websocket))

    try:
        done, pending = await asyncio.wait(
            {reader_task, writer_task, pinger_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        # Surface reader exceptions for the log; writer/pinger errors
        # are normal at shutdown.
        for task in done:
            exc = task.exception()
            if exc is not None and not isinstance(
                exc, (WebSocketDisconnect, asyncio.CancelledError)
            ):
                logger.warning("[ws/state] task exited with: {}", exc)
    finally:
        await hub.unregister_subscriber(sub)
        with contextlib.suppress(Exception):
            await websocket.close()


def _initial_bot_id_from_query(websocket: WebSocket) -> str | None:
    """Read ``bot_id`` from the connect URL so the SPA can hydrate fast.

    Sending it as a query parameter avoids a one-RTT delay between
    accept and the first ``subscribe`` frame on slow links.  Optional —
    clients may also subscribe explicitly after open.
    """
    try:
        params = websocket.query_params
    except Exception:  # noqa: BLE001 - older Starlette versions
        return None
    raw = params.get("bot_id")
    if not raw:
        return None
    raw = raw.strip()
    return raw or None


async def _push_initial_snapshots(bot_id: str) -> None:
    """Hydrate a fresh subscriber with the data they would otherwise fetch."""
    push_status_snapshot(bot_id)
    push_sessions_snapshot(bot_id)
    push_channels_snapshot(bot_id)
    push_mcp_snapshot(bot_id)


async def _reader_loop(websocket: WebSocket, hub: StateHub, sub: Any) -> None:
    """Forward inbound control frames to the hub."""
    while True:
        try:
            frame = await websocket.receive()
        except WebSocketDisconnect:
            return
        ftype = frame.get("type")
        if ftype == "websocket.disconnect":
            return
        text = frame.get("text")
        if text is None:
            # Binary frames are not part of the protocol; ignore them.
            continue
        if len(text) > _MAX_INBOUND_TEXT_BYTES:
            logger.warning(
                "[ws/state] inbound frame {} > {} bytes; closing",
                len(text),
                _MAX_INBOUND_TEXT_BYTES,
            )
            await _safe_send_json(
                websocket,
                {"type": "error", "data": {"code": "frame_too_large"}},
            )
            return
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        await _handle_control_frame(websocket, hub, sub, payload)


async def _handle_control_frame(
    websocket: WebSocket,
    hub: StateHub,
    sub: Any,
    payload: dict[str, Any],
) -> None:
    """Dispatch one parsed control frame from the SPA."""
    msg_type = payload.get("type")
    if msg_type == "ping":
        # Echo the original timestamp so the client can compute RTT.
        await _safe_send_json(
            websocket,
            {"type": "pong", "data": {"t": payload.get("t"), "server_time": time.time()}},
        )
        return
    if msg_type == "subscribe":
        bot_id = payload.get("bot_id")
        bot_id = bot_id.strip() if isinstance(bot_id, str) else None
        await hub.update_subscription(sub, bot_id)
        if bot_id:
            asyncio.create_task(_push_initial_snapshots(bot_id))
        return
    if msg_type == "unsubscribe":
        await hub.update_subscription(sub, None)
        return
    # Unknown types are ignored on purpose; we will add new control
    # verbs over time and old clients should not error on them.


async def _writer_loop(websocket: WebSocket, queue: asyncio.Queue[dict[str, Any]]) -> None:
    """Drain hub-published frames out to the socket."""
    while True:
        frame = await queue.get()
        try:
            await websocket.send_text(json.dumps(frame, ensure_ascii=False))
        except WebSocketDisconnect:
            return
        except Exception as exc:  # noqa: BLE001 - close on any send error
            logger.warning("[ws/state] send failed: {}", exc)
            return


async def _pinger_loop(websocket: WebSocket) -> None:
    """Server-side keepalive.

    Fires every :data:`SERVER_PING_INTERVAL_S` seconds.  Any send error
    aborts the connection — that is the desired behaviour when an idle
    proxy has silently dropped us, because it lets the writer/reader
    loops see ``ConnectionClosed`` and exit, triggering SPA reconnect.
    """
    while True:
        await asyncio.sleep(SERVER_PING_INTERVAL_S)
        try:
            await websocket.send_text(
                json.dumps({"type": "ping", "data": {"t": time.time()}})
            )
        except WebSocketDisconnect:
            return
        except Exception:  # noqa: BLE001
            return


async def _safe_send_json(websocket: WebSocket, frame: dict[str, Any]) -> None:
    try:
        await websocket.send_text(json.dumps(frame, ensure_ascii=False))
    except Exception:  # noqa: BLE001 - best-effort
        pass
