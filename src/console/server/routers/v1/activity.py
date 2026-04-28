"""Activity feed from OpenPawlet observability buffer (same source as /observability/timeline)."""

from __future__ import annotations

from fastapi import APIRouter, Query
from loguru import logger

from console.server.activity_feed import observability_rows_to_activity_items
from console.server.bot_workspace import workspace_root
from console.server.models import ActivityFeedPage, ActivityItem, DataResponse
from console.server.observability_jsonl import read_recent_observability_dicts
from console.server.openpawlet_user_config import resolve_config_path
from openpawlet.config.loader import load_config

router = APIRouter(tags=["Activity"])

# Probe larger raw batches until we have enough mapped+filtered rows for paging, capped per call.
_RAW_LIMIT_TIERS: tuple[int, ...] = (100, 200, 400, 800, 1600, 2000)


@router.get("/activity", response_model=DataResponse[ActivityFeedPage])
async def recent_activity(
    limit: int = Query(default=20, ge=1, le=200),
    skip: int = Query(default=0, ge=0, le=10_000),
    bot_id: str | None = Query(default=None, alias="bot_id"),
    activity_type: str | None = Query(default=None, alias="activity_type"),
) -> DataResponse[ActivityFeedPage]:
    """Recent agent activity with offset pagination over newest-first items."""
    path = resolve_config_path(bot_id)
    _ = load_config(path)
    filt = (
        activity_type.strip() if isinstance(activity_type, str) and activity_type.strip() else None
    )

    rows: list[dict] = []
    items: list[ActivityItem] = []
    for raw_lim in _RAW_LIMIT_TIERS:
        rows, source, err = read_recent_observability_dicts(
            workspace_root(bot_id),
            limit=raw_lim,
            trace_id=None,
        )
        if err is not None:
            logger.debug("activity feed: jsonl read failed: {} {}", source, err)
            return DataResponse(data=ActivityFeedPage(items=[], has_more=False))

        items = observability_rows_to_activity_items(rows, activity_type_filter=filt)

        enough = skip + limit + 1 <= len(items)
        exhausted = len(rows) < raw_lim
        if enough or exhausted:
            break

    page_items = items[skip : skip + limit]
    has_more = len(items) >= skip + limit + 1

    return DataResponse(data=ActivityFeedPage(items=page_items, has_more=has_more))
