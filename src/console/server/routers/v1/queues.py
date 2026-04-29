"""Console-side ``/api/v1/queues/*`` admin surface (in-process bus).

Historically these endpoints proxied to a separate ``open-pawlet-queue-manager``
broker.  In the consolidated single-process layout the message bus is the
in-memory :class:`~openpawlet.bus.queue.MessageBus`, so the proxy was removed
and these routes now report the local queue state directly via
:mod:`console.server.queues_router`.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from loguru import logger
from pydantic import BaseModel, Field

from console.server.app_state import get_message_bus, request_uptime_seconds
from console.server.queues_router import _disabled, _snapshot

router = APIRouter(tags=["Queues"])


class PauseBody(BaseModel):
    direction: str = Field(
        default="both",
        description="``inbound``, ``outbound`` or ``both``.",
    )
    paused: bool = Field(default=True)


class ReplayBody(BaseModel):
    message_id: str = Field(..., min_length=1)


class ClearDedupeBody(BaseModel):
    scope: str = Field(default="memory")


@router.get("/queues/snapshot", summary="Queue snapshot (in-process bus)")
async def queues_snapshot(request: Request) -> dict[str, Any]:
    """Return a unified snapshot of the in-process MessageBus."""
    return _snapshot(get_message_bus(request), request_uptime_seconds(request))


@router.post("/queues/pause", summary="Pause/resume (no-op for in-process bus)")
async def queues_pause(
    body: PauseBody,
    request: Request,
):
    logger.info(
        "queues: pause request direction={} paused={} (in-process no-op)",
        body.direction,
        body.paused,
    )
    return _disabled(
        "pause/resume is unavailable for the in-process MessageBus; "
        "remove the QueueManager dependency or run a dedicated broker."
    )


@router.post("/queues/replay", summary="Replay a previously seen message (disabled)")
async def queues_replay(body: ReplayBody, request: Request):
    logger.info("queues: replay request message_id={} (in-process no-op)", body.message_id)
    return _disabled(
        "message replay requires a persistent broker; the in-process "
        "MessageBus does not retain published frames."
    )


@router.post(
    "/queues/dedupe/clear",
    summary="Clear the idempotency store (no-op for in-process bus)",
)
async def queues_clear_dedupe(body: ClearDedupeBody, request: Request):
    logger.info("queues: clear_dedupe request scope={} (in-process no-op)", body.scope)
    return _disabled(
        "dedupe is not maintained by the in-process MessageBus; this "
        "endpoint is a no-op in the consolidated single-process layout."
    )
