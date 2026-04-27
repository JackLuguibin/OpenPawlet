"""Higher-level publishers that re-run the heavy aggregators.

Splitting these from :mod:`state_hub` avoids a dependency cycle:
``bot_workspace`` (which defines ``set_bot_running``) needs to publish a
fresh ``StatusResponse``, but the aggregators it would call
(``collect_dashboard_metrics`` etc.) all import ``bot_workspace``
themselves.  Putting the assembly logic in a module that *only*
``state_hub_helpers`` consumers import keeps the import graph acyclic.

These helpers swallow every exception by design: a state-push failure
must never break the underlying mutation.  The HTTP fallback path is
still in place, so the SPA recovers via its initial ``useQuery`` on the
next render even if a publish silently drops.
"""

from __future__ import annotations

from typing import Any

from loguru import logger

from console.server.state_hub import (
    publish_channels_update,
    publish_mcp_update,
    publish_sessions_update,
    publish_status_update,
)


def push_status_snapshot(bot_id: str | None) -> None:
    """Recompute ``GET /status`` and broadcast the result.

    Called from every code path that mutates a value the aggregator
    surfaces (running flag, default model, channels list, MCP servers,
    persisted session count).  Heavy lifting is shared with the HTTP
    handler so the two paths cannot diverge.
    """
    try:
        # Imported lazily so this module can be imported during early
        # bootstrap without dragging the full router dep tree.
        from console.server.bot_workspace import read_bot_runtime
        from console.server.channels_service import list_channel_statuses
        from console.server.dashboard_metrics import collect_dashboard_metrics
        from console.server.mcp_config import mcp_statuses_for_bot
        from console.server.models.status import placeholder_status
        from console.server.nanobot_user_config import (
            read_default_model,
            resolve_config_path,
        )

        base = placeholder_status()
        path = resolve_config_path(bot_id)
        model = read_default_model(path)
        mcp_rows = mcp_statuses_for_bot(bot_id)
        running, uptime_seconds = read_bot_runtime(bot_id)
        metrics = collect_dashboard_metrics(bot_id, history_days=14)
        channels = list_channel_statuses(bot_id)
        snapshot = base.model_copy(
            update={
                "model": model,
                "mcp_servers": mcp_rows,
                "running": running,
                "uptime_seconds": uptime_seconds,
                "active_sessions": metrics.active_sessions,
                "messages_today": metrics.messages_today,
                "token_usage": metrics.token_usage_today,
                "model_token_totals": metrics.model_token_totals,
                "channels": channels,
            }
        )
        publish_status_update(bot_id, snapshot.model_dump(mode="json"))
    except Exception:  # noqa: BLE001 - never let a publish failure escape
        logger.exception("[state-hub] push_status_snapshot failed")


def push_sessions_snapshot(bot_id: str | None) -> None:
    """Recompute the session list and broadcast it.

    Mirrors ``GET /sessions`` exactly so the SPA's ``setQueryData`` path
    sees the same shape it would on a manual refetch.
    """
    try:
        from console.server.routers.v1.sessions import _row_to_session_info
        from console.server.session_store import list_session_rows

        rows = list_session_rows(bot_id)
        sessions: list[dict[str, Any]] = [
            _row_to_session_info(r).model_dump(mode="json") for r in rows
        ]
        publish_sessions_update(bot_id, sessions)
    except Exception:  # noqa: BLE001
        logger.exception("[state-hub] push_sessions_snapshot failed")


def push_channels_snapshot(bot_id: str | None) -> None:
    try:
        from console.server.channels_service import list_channel_statuses

        channels = [c.model_dump(mode="json") for c in list_channel_statuses(bot_id)]
        publish_channels_update(bot_id, channels)
    except Exception:  # noqa: BLE001
        logger.exception("[state-hub] push_channels_snapshot failed")


def push_mcp_snapshot(bot_id: str | None) -> None:
    try:
        from console.server.mcp_config import mcp_statuses_for_bot

        rows = [m.model_dump(mode="json") for m in mcp_statuses_for_bot(bot_id)]
        publish_mcp_update(bot_id, rows)
    except Exception:  # noqa: BLE001
        logger.exception("[state-hub] push_mcp_snapshot failed")


def push_after_config_change(bot_id: str | None) -> None:
    """Convenience: a generic config save touches multiple snapshots."""
    push_status_snapshot(bot_id)
    push_channels_snapshot(bot_id)
    push_mcp_snapshot(bot_id)
