"""Control plane: stop task, restart (stub)."""

from __future__ import annotations

from fastapi import APIRouter, Query

from console.server.models import DataResponse, OkBody

router = APIRouter(tags=["Control"])


@router.post("/control/stop", response_model=DataResponse[OkBody])
async def stop_current_task(
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[OkBody]:
    """Stop current task (stub)."""
    _ = bot_id
    return DataResponse(data=OkBody())


@router.post("/control/restart", response_model=DataResponse[OkBody])
async def restart_bot(
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[OkBody]:
    """Restart bot (stub)."""
    _ = bot_id
    return DataResponse(data=OkBody())
