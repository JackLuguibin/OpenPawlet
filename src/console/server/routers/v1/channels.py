"""Channel configuration and refresh."""

from __future__ import annotations

from typing import Any, NoReturn

from fastapi import APIRouter, Query, Request
from loguru import logger

from console.server.channels_service import (
    ChannelNotFoundError,
    channel_plugin_exists,
    disable_channel,
    list_channel_statuses,
    merge_channel_patch,
    plugin_channel_names,
    refresh_channel_results,
)
from console.server.http_errors import bad_request, not_found_detail
from console.server.models import DataResponse, OkBody
from console.server.models.channels import (
    ChannelRefreshResult,
    ChannelUpdateBody,
)
from console.server.models.status import ChannelStatus
from console.server.state_hub_helpers import (
    push_channels_snapshot,
    push_status_snapshot,
)

router = APIRouter(tags=["Channels"])


def _unknown_channel(name: str) -> NoReturn:
    not_found_detail(f"Unknown channel: {name}")


async def _hot_reload_runtime_for_bot(request: Request, bot_id: str | None) -> None:
    """Rebuild the embedded runtime so channel config changes take effect.

    Channels are wired into the bus and outbound pipeline at construction
    time, so they cannot be hot-swapped in place. This helper centralises
    the swap so every channel-mutating endpoint goes through the same
    "save -> rebuild -> snapshot" flow.
    """
    from console.server.lifespan import swap_runtime

    target_bot = bot_id or getattr(request.app.state, "active_bot_id", None) or "default"
    try:
        await swap_runtime(request.app, target_bot)
    except Exception:  # noqa: BLE001 - never break the save path
        logger.opt(exception=True).debug(
            "swap_runtime after channel mutation failed (restart may be needed for wiring)"
        )


@router.get("/channels", response_model=DataResponse[list[ChannelStatus]])
async def list_channels(
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[list[ChannelStatus]]:
    """List channel status rows from ``config.json`` and runtime."""
    return DataResponse(data=list_channel_statuses(bot_id))


@router.put("/channels/{name}", response_model=DataResponse[dict[str, Any]])
async def update_channel(
    request: Request,
    name: str,
    body: ChannelUpdateBody,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[dict[str, Any]]:
    """Merge ``body.data`` into ``channels.<name>`` and save ``config.json``.

    The save triggers a runtime rebuild via :func:`swap_runtime` so the
    user does not need to restart the console for the new channel
    settings to take effect.
    """
    try:
        saved = merge_channel_patch(bot_id, name, body.data)
    except ValueError as exc:
        bad_request(str(exc), cause=exc)
    await _hot_reload_runtime_for_bot(request, bot_id)
    push_channels_snapshot(bot_id)
    push_status_snapshot(bot_id)
    return DataResponse(data=saved)


@router.delete("/channels/{name}", response_model=DataResponse[OkBody])
async def delete_channel(
    request: Request,
    name: str,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[OkBody]:
    """Disable a channel (sets ``enabled`` to false)."""
    try:
        disable_channel(bot_id, name)
    except ChannelNotFoundError as exc:
        not_found_detail(str(exc), cause=exc)
    except ValueError as exc:
        bad_request(str(exc), cause=exc)
    await _hot_reload_runtime_for_bot(request, bot_id)
    push_channels_snapshot(bot_id)
    push_status_snapshot(bot_id)
    return DataResponse(data=OkBody())


@router.post(
    "/channels/refresh",
    response_model=DataResponse[list[ChannelRefreshResult]],
)
async def refresh_all_channels(
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[list[ChannelRefreshResult]]:
    """Re-evaluate channel entries (config snapshot refresh)."""
    names = plugin_channel_names(bot_id)
    return DataResponse(data=refresh_channel_results(bot_id, names))


@router.post(
    "/channels/{name}/refresh",
    response_model=DataResponse[ChannelRefreshResult],
)
async def refresh_channel(
    name: str,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[ChannelRefreshResult]:
    """Refresh one channel entry."""
    if not channel_plugin_exists(bot_id, name):
        _unknown_channel(name)
    results = refresh_channel_results(bot_id, [name])
    if not results:
        _unknown_channel(name)
    return DataResponse(data=results[0])
