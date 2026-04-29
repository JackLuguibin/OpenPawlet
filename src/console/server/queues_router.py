"""Queue inspection routes for the unified console FastAPI app.

The legacy ``open-pawlet-queue-manager`` broker used to expose these
endpoints over a separate FastAPI process backed by ZeroMQ sockets and a
shared idempotency store.  In the consolidated single-process layout the
queue is the in-memory :class:`~openpawlet.bus.queue.MessageBus`, so this
module reports the live queue depth instead and exposes admin write
endpoints as best-effort no-ops (returning ``409 disabled`` to make the
behaviour explicit to existing UIs that still call them).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from typing import TYPE_CHECKING

from fastapi import APIRouter, FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from loguru import logger

from console.server.app_state import app_uptime_seconds, get_message_bus, request_uptime_seconds
from openpawlet.bus.stats_models import (
    BusDedupeStats,
    BusPausedFlags,
    MessageBusStatsSnapshot,
    QueueModeBlock,
    QueuesGoneBody,
    QueuesHealthResponse,
    QueuesHttpSnapshot,
    QueuesStreamTick,
)

if TYPE_CHECKING:
    from openpawlet.bus.queue import MessageBus


_MODE_TAG = "in_process"
_VERSION_TAG = "in-process"


def _bus_stats(bus: MessageBus | None) -> MessageBusStatsSnapshot:
    """Return the live stats block from *bus* (empty when bus missing)."""
    if bus is None:
        return MessageBusStatsSnapshot(
            metrics={"inbound_pending": 0, "outbound_pending": 0},
            rates={},
            paused=BusPausedFlags(),
            dedupe=BusDedupeStats(),
            samples=[],
        )
    snapshot_fn = getattr(bus, "stats_snapshot", None)
    if callable(snapshot_fn):
        try:
            stats = snapshot_fn() or {}
        except Exception:  # pragma: no cover - stats must never break the API
            logger.exception("bus.stats_snapshot() failed; falling back to bare counters")
            stats = {}
    else:
        stats = {}
    inbound = int(getattr(bus, "inbound_size", 0))
    outbound = int(getattr(bus, "outbound_size", 0))
    metrics_raw = dict(stats.get("metrics") or {})
    metrics_raw.setdefault("inbound_pending", inbound)
    metrics_raw.setdefault("outbound_pending", outbound)
    metrics = {str(k): int(v) for k, v in metrics_raw.items()}
    rates_raw = dict(stats.get("rates") or {})
    rates = {str(k): float(v) for k, v in rates_raw.items()}
    paused_raw = dict(
        stats.get("paused") or {"inbound": False, "outbound": False, "events": False}
    )
    dedupe_raw = dict(
        stats.get("dedupe")
        or {"enabled": False, "hits": 0, "misses": 0, "size": 0, "persist_size": 0}
    )
    return MessageBusStatsSnapshot(
        metrics=metrics,
        rates=rates,
        paused=BusPausedFlags.model_validate(paused_raw),
        dedupe=BusDedupeStats.model_validate(dedupe_raw),
        samples=list(stats.get("samples") or []),
    )


def _snapshot(
    bus: MessageBus | None,
    uptime_s: float,
    *,
    include_samples: bool = True,
) -> QueuesHttpSnapshot:
    """Return a unified snapshot describing the in-process queue state."""
    stats = _bus_stats(bus)
    samples = stats.samples if include_samples else []
    mode_block = QueueModeBlock(mode=_MODE_TAG)
    return QueuesHttpSnapshot(
        status="ok",
        version=_VERSION_TAG,
        uptime_s=round(uptime_s, 3),
        settings=mode_block,
        topology=mode_block,
        metrics=stats.metrics,
        rates=stats.rates,
        paused=stats.paused,
        dedupe=stats.dedupe,
        connections=[],
        samples=samples,
    )


def _gone(message: str) -> JSONResponse:
    """Return 410 Gone for endpoints removed in the in-process layout.

    The earlier code returned 409 for these handlers, which any existing
    SPA build interpreted as a transient error worth surfacing to the
    user.  410 is the correct semantic - "this resource will not return
    in this layout" - and lets the SPA gate the affected buttons.
    """
    return JSONResponse(
        QueuesGoneBody(error=message, mode=_MODE_TAG).model_dump(mode="json"),
        status_code=410,
    )


# Backwards-compatible alias kept so existing tests that imported the
# pre-410 helper name (``_disabled``) keep working without churn.
_disabled = _gone


async def _snapshot_route(request: Request) -> Response:
    snap = _snapshot(get_message_bus(request), request_uptime_seconds(request))
    return JSONResponse(snap.model_dump(mode="json"))


async def _health_route(request: Request) -> Response:
    snap = _snapshot(get_message_bus(request), request_uptime_seconds(request))
    health = QueuesHealthResponse(
        status=snap.status,
        version=snap.version,
        uptime_s=snap.uptime_s,
        metrics=snap.metrics,
    )
    return JSONResponse(health.model_dump(mode="json"))


async def _pause_route(_request: Request) -> Response:
    return _gone(
        "pause/resume is unavailable for the in-process MessageBus; "
        "remove the QueueManager dependency or run a dedicated broker."
    )


async def _replay_route(_request: Request) -> Response:
    return _gone(
        "message replay requires a persistent broker; the in-process "
        "MessageBus does not retain published frames."
    )


async def _clear_dedupe_route(_request: Request) -> Response:
    return _gone(
        "dedupe is not maintained by the in-process MessageBus; this "
        "endpoint is a no-op in the consolidated single-process layout."
    )


_STREAM_INTERVAL_S = 1.0
_STREAM_OPTIONAL_TOPICS = frozenset({"samples"})


def _apply_subscription_op(active_topics: set[str], raw: str) -> None:
    """Mutate *active_topics* per a client ``{op, topics}`` control frame."""
    try:
        msg = json.loads(raw)
    except (ValueError, TypeError):
        return
    if not isinstance(msg, dict):
        return
    op = str(msg.get("op") or "").strip().lower()
    topics_raw = msg.get("topics")
    if not isinstance(topics_raw, list):
        return
    topics = {str(t) for t in topics_raw if str(t) in _STREAM_OPTIONAL_TOPICS}
    if op == "subscribe":
        active_topics.update(topics)
    elif op == "unsubscribe":
        active_topics.difference_update(topics)


async def _stream_route(websocket: WebSocket) -> None:
    """Push periodic snapshots over WebSocket; matches the legacy stream API."""
    await websocket.accept()
    bus = get_message_bus(websocket)
    state = websocket.app.state
    active_topics: set[str] = set()
    try:
        while True:
            include_samples = "samples" in active_topics
            snap = _snapshot(bus, app_uptime_seconds(state), include_samples=include_samples)
            tick = QueuesStreamTick(
                type="tick",
                at=time.time(),
                metrics=snap.metrics,
                rates=snap.rates,
                paused=snap.paused,
                dedupe=snap.dedupe,
                connections=snap.connections,
                samples=snap.samples if include_samples else None,
            )
            try:
                await websocket.send_json(tick.model_dump(mode="json", exclude_none=True))
            except Exception:
                break
            try:
                raw = await asyncio.wait_for(
                    websocket.receive_text(), timeout=_STREAM_INTERVAL_S
                )
            except TimeoutError:
                continue
            except WebSocketDisconnect:
                break
            except Exception:
                break
            _apply_subscription_op(active_topics, raw)
    finally:
        with contextlib.suppress(Exception):  # pragma: no cover
            await websocket.close()


def install_queues_routes(app: FastAPI) -> APIRouter:
    """Register ``/queues/*`` routes on *app*."""
    router = APIRouter()
    router.add_api_route("/queues/health", _health_route, methods=["GET"])
    router.add_api_route("/queues/snapshot", _snapshot_route, methods=["GET"])
    router.add_api_route("/queues/pause", _pause_route, methods=["POST"])
    router.add_api_route("/queues/replay", _replay_route, methods=["POST"])
    router.add_api_route("/queues/dedupe/clear", _clear_dedupe_route, methods=["POST"])
    app.include_router(router)
    app.add_api_websocket_route("/queues/stream", _stream_route)
    # Legacy alias: the SPA + Vite dev proxy historically connect to
    # ``/queues-ws`` (kept for backward compatibility with deployments that
    # still proxy that path).  Both routes share the same handler.
    app.add_api_websocket_route("/queues-ws", _stream_route)
    logger.info("Queues admin routes registered (in-process bus)")
    return router


__all__ = ["install_queues_routes"]
