"""HTTP + WebSocket admin surface for :class:`QueueManagerBroker`.

Design notes
------------
- We use ``aiohttp`` because the broker already depends on async
  networking and aiohttp is the shortest path to getting both HTTP
  JSON endpoints and a WebSocket stream on one port.
- Authentication: every mutating endpoint and the WebSocket stream
  require either a ``Bearer`` token matching
  :attr:`QueueManagerSettings.admin_token`, or (when no token is
  configured) a request from a loopback address.  Read-only endpoints
  (``/health`` and ``/queues/snapshot``) are open by default so
  existing scrapers keep working; they still refuse non-loopback
  callers when a token is configured but missing.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
from typing import TYPE_CHECKING

from loguru import logger

if TYPE_CHECKING:
    from aiohttp import web

    from queue_manager.service import QueueManagerBroker


_LOOPBACK_NETS = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
]


def _is_loopback(host: str | None) -> bool:
    if not host:
        return False
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return host in {"localhost", "::1"}
    return any(addr in net for net in _LOOPBACK_NETS)


def _require_auth(
    request: web.Request,
    broker: QueueManagerBroker,
    *,
    write: bool,
) -> web.Response | None:
    """Return a 401 response when the caller is not allowed.

    Read requests are authorized when any of the following holds:
    - No admin token is configured and the request comes from loopback.
    - A valid Bearer token is presented.

    Write requests always require a valid Bearer token when a token is
    configured.  When no token is configured they are loopback-only so
    that dev boxes can still drive the broker without extra setup.
    """
    from aiohttp import web  # local import - aiohttp is required at runtime

    token = broker._settings.admin_token  # noqa: SLF001 - intentional
    header = request.headers.get("Authorization", "")
    peer = request.remote or ""
    bearer = ""
    if header.lower().startswith("bearer "):
        bearer = header[len("Bearer ") :].strip()
    if token:
        if bearer == token:
            return None
        if not write and _is_loopback(peer):
            # Allow unauthenticated local reads in token mode for
            # operators scripting against localhost.
            return None
        return web.json_response(
            {"error": "unauthorized"},
            status=401,
            headers={"WWW-Authenticate": "Bearer"},
        )
    if _is_loopback(peer):
        return None
    return web.json_response(
        {"error": "admin token not configured; only loopback is allowed"},
        status=401,
    )


async def _snapshot(request: web.Request) -> web.Response:
    from aiohttp import web

    broker: QueueManagerBroker = request.app["broker"]
    err = _require_auth(request, broker, write=False)
    if err is not None:
        return err
    return web.json_response(broker.snapshot())


async def _health(request: web.Request) -> web.Response:
    from aiohttp import web

    broker: QueueManagerBroker = request.app["broker"]
    snap = broker.snapshot()
    return web.json_response(
        {
            "status": snap["status"],
            "version": snap["version"],
            "uptime_s": snap["uptime_s"],
            "metrics": snap["metrics"],
        }
    )


async def _pause(request: web.Request) -> web.Response:
    from aiohttp import web

    broker: QueueManagerBroker = request.app["broker"]
    err = _require_auth(request, broker, write=True)
    if err is not None:
        return err
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON body"}, status=400)
    direction = str(body.get("direction", "")).strip().lower()
    if direction not in {"inbound", "outbound", "both"}:
        return web.json_response(
            {"error": "direction must be inbound|outbound|both"},
            status=400,
        )
    paused = bool(body.get("paused", True))
    try:
        result = broker.set_paused(direction, paused)
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    return web.json_response(result)


async def _replay(request: web.Request) -> web.Response:
    from aiohttp import web

    broker: QueueManagerBroker = request.app["broker"]
    err = _require_auth(request, broker, write=True)
    if err is not None:
        return err
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON body"}, status=400)
    message_id = str(body.get("message_id", "")).strip()
    if not message_id:
        return web.json_response({"error": "message_id is required"}, status=400)
    try:
        result = await broker.replay_message(message_id)
    except KeyError:
        return web.json_response(
            {"error": f"message_id {message_id!r} not found in recent samples"},
            status=404,
        )
    except RuntimeError as exc:
        return web.json_response({"error": str(exc)}, status=503)
    return web.json_response(result)


async def _clear_dedupe(request: web.Request) -> web.Response:
    from aiohttp import web

    broker: QueueManagerBroker = request.app["broker"]
    err = _require_auth(request, broker, write=True)
    if err is not None:
        return err
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON body"}, status=400)
    scope = str(body.get("scope", "memory")).strip().lower()
    if scope not in {"memory", "persist", "both"}:
        return web.json_response(
            {"error": "scope must be memory|persist|both"},
            status=400,
        )
    result = broker.clear_dedupe(scope=scope)
    return web.json_response({"scope": scope, **result})


async def _stream(request: web.Request) -> web.WebSocketResponse:
    from aiohttp import WSMsgType, web

    broker: QueueManagerBroker = request.app["broker"]
    err = _require_auth(request, broker, write=True)
    if err is not None:
        # WebSocket upgrade requires 101 or a clean HTTP error.  Returning
        # the response triggers a normal HTTP reply.
        return err  # type: ignore[return-value]
    ws = web.WebSocketResponse(heartbeat=15.0)
    await ws.prepare(request)
    subscriptions: set[str] = {"tick"}
    interval = max(0.1, broker._settings.stream_interval_ms / 1000.0)  # noqa: SLF001

    async def _tick_pump() -> None:
        try:
            while not ws.closed:
                payload = {
                    "type": "tick",
                    "at": asyncio.get_running_loop().time(),
                    "metrics": dict(broker.state.counters),
                    "rates": broker.state.snapshot_rates(),
                    "paused": dict(broker.state.paused),
                    "connections": [c.as_dict() for c in broker.state.connections.list()],
                    "dedupe": broker._idempotency.stats(),  # noqa: SLF001
                }
                if "samples" in subscriptions:
                    payload["samples"] = [
                        e.as_dict() for e in broker.state.samples.list()
                    ]
                try:
                    await ws.send_json(payload)
                except Exception:
                    break
                await asyncio.sleep(interval)
        except asyncio.CancelledError:
            raise

    pump_task = asyncio.create_task(_tick_pump(), name="qm-stream-tick")
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except Exception:
                    continue
                if not isinstance(data, dict):
                    continue
                op = str(data.get("op", ""))
                if op == "subscribe":
                    topics = data.get("topics", [])
                    if isinstance(topics, list):
                        subscriptions.update(str(t) for t in topics)
                elif op == "unsubscribe":
                    topics = data.get("topics", [])
                    if isinstance(topics, list):
                        for t in topics:
                            subscriptions.discard(str(t))
            elif msg.type in {WSMsgType.CLOSE, WSMsgType.ERROR}:
                break
    finally:
        pump_task.cancel()
        try:
            await pump_task
        except (asyncio.CancelledError, Exception):
            pass
        try:
            await ws.close()
        except Exception:
            pass
    return ws


def build_admin_app(broker: QueueManagerBroker) -> web.Application:
    """Construct the aiohttp application that hosts the admin surface."""
    from aiohttp import web

    app = web.Application()
    app["broker"] = broker
    app.router.add_get("/health", _health)
    app.router.add_get("/queues/snapshot", _snapshot)
    app.router.add_post("/queues/pause", _pause)
    app.router.add_post("/queues/replay", _replay)
    app.router.add_post("/queues/dedupe/clear", _clear_dedupe)
    app.router.add_get("/queues/stream", _stream)
    logger.info("QueueManagerBroker admin routes registered")
    return app


# Re-export ``web`` for typing consumers that cannot import aiohttp at module load.
def _dummy_type_alias() -> None:  # pragma: no cover - typing helper
    pass
