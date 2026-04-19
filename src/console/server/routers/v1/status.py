"""Aggregate runtime status."""

from __future__ import annotations

from fastapi import APIRouter, Query

from console.server.bot_workspace import read_bot_runtime
from console.server.channels_service import list_channel_statuses
from console.server.dashboard_metrics import collect_dashboard_metrics
from console.server.mcp_config import mcp_statuses_for_bot
from console.server.models import DataResponse, StatusResponse
from console.server.models.status import placeholder_status
from console.server.nanobot_user_config import (
    read_default_model,
    resolve_config_path,
)

router = APIRouter(tags=["Status"])


@router.get("/status", response_model=DataResponse[StatusResponse])
async def get_status(
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[StatusResponse]:
    """Return status; ``model`` and ``mcp_servers`` reflect ``config.json``."""
    base = placeholder_status()
    path = resolve_config_path(bot_id)
    model = read_default_model(path)
    mcp_rows = mcp_statuses_for_bot(bot_id)
    running, uptime_seconds = read_bot_runtime(bot_id)
    metrics = collect_dashboard_metrics(bot_id, history_days=14)
    return DataResponse(
        data=base.model_copy(
            update={
                "model": model,
                "mcp_servers": mcp_rows,
                "running": running,
                "uptime_seconds": uptime_seconds,
                "active_sessions": metrics.active_sessions,
                "messages_today": metrics.messages_today,
                "token_usage": metrics.token_usage_today,
                "channels": list_channel_statuses(bot_id),
            }
        )
    )
