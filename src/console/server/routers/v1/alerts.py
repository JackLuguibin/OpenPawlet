"""Alerts (stub)."""

from __future__ import annotations

from fastapi import APIRouter, Query

from console.server.models import Alert, DataResponse, OkBody

router = APIRouter(tags=["Alerts"])


@router.get("/alerts", response_model=DataResponse[list[Alert]])
async def list_alerts(
    bot_id: str | None = Query(default=None, alias="bot_id"),
    include_dismissed: bool = Query(default=False, alias="include_dismissed"),
) -> DataResponse[list[Alert]]:
    """List alerts (stub)."""
    _ = bot_id, include_dismissed
    return DataResponse(data=[])


@router.post("/alerts/{alert_id}/dismiss", response_model=DataResponse[OkBody])
async def dismiss_alert(
    alert_id: str,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[OkBody]:
    """Dismiss alert (stub)."""
    _ = alert_id, bot_id
    return DataResponse(data=OkBody())
