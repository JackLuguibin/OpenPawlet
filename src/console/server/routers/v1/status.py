"""Aggregate runtime status."""

from __future__ import annotations

from fastapi import APIRouter, Query, Request

from console.server.bot_workspace import read_bot_runtime
from console.server.bots_registry import get_registry
from console.server.channels_service import list_channel_statuses
from console.server.dashboard_metrics import collect_dashboard_metrics
from console.server.mcp_config import mcp_statuses_for_bot
from console.server.models import DataResponse, StatusResponse
from console.server.models.status import placeholder_status
from console.server.openpawlet_user_config import (
    read_default_model,
    resolve_config_path,
)

router = APIRouter(tags=["Status"])


def _runtime_status_for_bot(request: Request, bot_id: str | None) -> tuple[bool, float] | None:
    """Return runtime manager status for the requested bot when available.

    The embedded runtime only runs one bot at a time. We should only trust
    ``agent_manager`` for the currently active bot; otherwise fall back to
    per-bot persisted state.
    """
    manager = getattr(request.app.state, "agent_manager", None)
    if manager is None:
        return None
    active_bot_id = str(getattr(request.app.state, "active_bot_id", "") or "").strip()
    try:
        requested_bot_id = str(bot_id or get_registry().default_id()).strip()
    except Exception:
        requested_bot_id = str(bot_id or "").strip()
    if requested_bot_id and active_bot_id and requested_bot_id != active_bot_id:
        return None
    row = manager.get_status("main")
    if row is None:
        return None
    uptime = float(row.uptime_seconds or 0.0) if row.running else 0.0
    return bool(row.running), uptime


@router.get("/status", response_model=DataResponse[StatusResponse])
async def get_status(
    request: Request,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[StatusResponse]:
    """Return status; ``model`` and ``mcp_servers`` reflect ``config.json``."""
    base = placeholder_status()
    path = resolve_config_path(bot_id)
    model = read_default_model(path)
    mcp_rows = mcp_statuses_for_bot(bot_id)
    runtime_status = _runtime_status_for_bot(request, bot_id)
    running, uptime_seconds = runtime_status or read_bot_runtime(bot_id)
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
                "model_token_totals": metrics.model_token_totals,
                "channels": list_channel_statuses(bot_id),
            }
        )
    )
