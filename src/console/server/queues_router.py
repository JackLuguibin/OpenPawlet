"""Queue inspection routes for the unified console FastAPI app.

The legacy ``open-pawlet-queue-manager`` broker used to expose these
endpoints over a separate FastAPI process backed by ZeroMQ sockets and a
shared idempotency store.  In the consolidated single-process layout the
queue is the in-memory :class:`~nanobot.bus.queue.MessageBus`, so this
module reports the live queue depth instead and exposes admin write
endpoints as best-effort no-ops (returning ``409 disabled`` to make the
behaviour explicit to existing UIs that still call them).
"""

from __future__ import annotations

import asyncio
import time
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from loguru import logger

if TYPE_CHECKING:
    from nanobot.bus.queue import MessageBus


def _bus_from_request(request: Request) -> "MessageBus | None":
    bus = getattr(request.app.state, "message_bus", None)
    return bus  # type: ignore[return-value]


def _snapshot(bus: "MessageBus | None", uptime_s: float) -> dict[str, Any]:
    """Return a unified snapshot describing the in-process queue state."""
    inbound = int(getattr(bus, "inbound_size", 0)) if bus is not None else 0
    outbound = int(getattr(bus, "outbound_size", 0)) if bus is not None else 0
    return {
        "status": "ok",
        "version": "in-process",
        "uptime_s": round(uptime_s, 3),
        "settings": {"mode": "in_process"},
        "topology": {"mode": "in_process"},
        "metrics": {"inbound_pending": inbound, "outbound_pending": outbound},
        "rates": {},
        "paused": {"inbound": False, "outbound": False, "events": False},
        "dedupe": {"enabled": False, "tracked": 0},
        "connections": [],
        "samples": [],
    }


def _disabled(message: str) -> JSONResponse:
    return JSONResponse(
        {"error": message, "mode": "in_process"},
        status_code=409,
    )


async def _snapshot_route(request: Request) -> Response:
    bus = _bus_from_request(request)
    started_at = float(getattr(request.app.state, "started_at_perf", time.perf_counter()))
    return JSONResponse(_snapshot(bus, time.perf_counter() - started_at))


async def _health_route(request: Request) -> Response:
    bus = _bus_from_request(request)
    started_at = float(getattr(request.app.state, "started_at_perf", time.perf_counter()))
    snap = _snapshot(bus, time.perf_counter() - started_at)
    return JSONResponse(
        {
            "status": snap["status"],
            "version": snap["version"],
            "uptime_s": snap["uptime_s"],
            "metrics": snap["metrics"],
        }
    )


async def _pause_route(_request: Request) -> Response:
    return _disabled(
        "pause/resume is unavailable for the in-process MessageBus; "
        "remove the QueueManager dependency or run a dedicated broker."
    )


async def _replay_route(_request: Request) -> Response:
    return _disabled(
        "message replay requires a persistent broker; the in-process "
        "MessageBus does not retain published frames."
    )


async def _clear_dedupe_route(_request: Request) -> Response:
    return _disabled(
        "dedupe is not maintained by the in-process MessageBus; this "
        "endpoint is a no-op in the consolidated single-process layout."
    )


async def _stream_route(websocket: WebSocket) -> None:
    """Push periodic snapshots over WebSocket; matches the legacy stream API."""
    await websocket.accept()
    bus = getattr(websocket.app.state, "message_bus", None)
    started_at = float(
        getattr(websocket.app.state, "started_at_perf", time.perf_counter())
    )
    interval = 1.0
    try:
        while True:
            payload = {
                "type": "tick",
                "at": time.time(),
                **{
                    k: v
                    for k, v in _snapshot(bus, time.perf_counter() - started_at).items()
                    if k in {"metrics", "rates", "paused", "connections", "dedupe"}
                },
            }
            try:
                await websocket.send_json(payload)
            except Exception:
                break
            try:
                await asyncio.wait_for(websocket.receive_text(), timeout=interval)
            except asyncio.TimeoutError:
                continue
            except WebSocketDisconnect:
                break
            except Exception:
                break
    finally:
        try:
            await websocket.close()
        except Exception:  # pragma: no cover
            pass


def install_queues_routes(app: FastAPI) -> APIRouter:
    """Register ``/queues/*`` routes on *app*."""
    router = APIRouter()
    router.add_api_route("/queues/health", _health_route, methods=["GET"])
    router.add_api_route("/queues/snapshot", _snapshot_route, methods=["GET"])
    router.add_api_route("/queues/pause", _pause_route, methods=["POST"])
    router.add_api_route("/queues/replay", _replay_route, methods=["POST"])
    router.add_api_route(
        "/queues/dedupe/clear", _clear_dedupe_route, methods=["POST"]
    )
    app.include_router(router)
    app.add_api_websocket_route("/queues/stream", _stream_route)
    logger.info("Queues admin routes registered (in-process bus)")
    return router


__all__ = ["install_queues_routes"]
