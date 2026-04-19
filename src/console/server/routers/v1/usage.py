"""Token usage history from workspace session aggregates."""

from __future__ import annotations

from fastapi import APIRouter, Query

from console.server.dashboard_metrics import collect_dashboard_metrics
from console.server.models import DataResponse, UsageHistoryItem

router = APIRouter(tags=["Usage"])


@router.get("/usage/history", response_model=DataResponse[list[UsageHistoryItem]])
async def usage_history(
    bot_id: str | None = Query(default=None, alias="bot_id"),
    days: int = Query(default=14, ge=1, le=366),
) -> DataResponse[list[UsageHistoryItem]]:
    """Daily usage history derived from per-message ``usage`` fields in sessions."""
    metrics = collect_dashboard_metrics(bot_id, history_days=days)
    return DataResponse(data=metrics.history)
