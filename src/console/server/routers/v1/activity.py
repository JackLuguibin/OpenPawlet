"""Activity feed (stub)."""

from __future__ import annotations

from fastapi import APIRouter, Query

from console.server.models import ActivityItem, DataResponse

router = APIRouter(tags=["Activity"])


@router.get("/activity", response_model=DataResponse[list[ActivityItem]])
async def recent_activity(
    limit: int = Query(default=20, ge=1, le=200),
    bot_id: str | None = Query(default=None, alias="bot_id"),
    activity_type: str | None = Query(default=None, alias="activity_type"),
) -> DataResponse[list[ActivityItem]]:
    """Recent activity (stub)."""
    _ = limit, bot_id, activity_type
    return DataResponse(data=[])
