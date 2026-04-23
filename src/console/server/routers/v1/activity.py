"""Activity feed from nanobot observability buffer (same source as /observability/timeline)."""

from __future__ import annotations

from fastapi import APIRouter, Query
from loguru import logger

from console.server.activity_feed import observability_rows_to_activity_items
from console.server.models import ActivityItem, DataResponse
from console.server.bot_workspace import workspace_root
from console.server.observability_jsonl import read_recent_observability_dicts
from console.server.nanobot_user_config import resolve_config_path
from nanobot.config.loader import load_config

router = APIRouter(tags=["Activity"])


@router.get("/activity", response_model=DataResponse[list[ActivityItem]])
async def recent_activity(
    limit: int = Query(default=100, ge=1, le=2000),
    bot_id: str | None = Query(default=None, alias="bot_id"),
    activity_type: str | None = Query(default=None, alias="activity_type"),
) -> DataResponse[list[ActivityItem]]:
    """Recent agent activity (run / LLM / tool) from JSONL under the bot workspace."""
    path = resolve_config_path(bot_id)
    _ = load_config(path)
    rows, source, err = read_recent_observability_dicts(
        workspace_root(bot_id),
        limit=limit,
        trace_id=None,
    )
    if err is not None:
        logger.debug("activity feed: jsonl read failed: {} {}", source, err)
        return DataResponse(data=[])

    filt = activity_type.strip() if isinstance(activity_type, str) and activity_type.strip() else None
    items = observability_rows_to_activity_items(rows, activity_type_filter=filt)
    return DataResponse(data=items)
