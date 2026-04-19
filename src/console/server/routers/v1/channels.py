"""Channel configuration and refresh."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from console.server.channels_service import (
    ChannelNotFoundError,
    channel_plugin_exists,
    disable_channel,
    list_channel_statuses,
    merge_channel_patch,
    plugin_channel_names,
    refresh_channel_results,
)
from console.server.models import DataResponse, OkBody
from console.server.models.channels import (
    ChannelRefreshResult,
    ChannelUpdateBody,
)
from console.server.models.status import ChannelStatus

router = APIRouter(tags=["Channels"])


@router.get("/channels", response_model=DataResponse[list[ChannelStatus]])
async def list_channels(
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[list[ChannelStatus]]:
    """List channel status rows from ``config.json`` and runtime."""
    return DataResponse(data=list_channel_statuses(bot_id))


@router.put("/channels/{name}", response_model=DataResponse[dict[str, Any]])
async def update_channel(
    name: str,
    body: ChannelUpdateBody,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[dict[str, Any]]:
    """Merge ``body.data`` into ``channels.<name>`` and save ``config.json``."""
    try:
        saved = merge_channel_patch(bot_id, name, body.data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return DataResponse(data=saved)


@router.delete("/channels/{name}", response_model=DataResponse[OkBody])
async def delete_channel(
    name: str,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[OkBody]:
    """Disable a channel (sets ``enabled`` to false)."""
    try:
        disable_channel(bot_id, name)
    except ChannelNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
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
        raise HTTPException(status_code=404, detail=f"Unknown channel: {name}")
    results = refresh_channel_results(bot_id, [name])
    if not results:
        raise HTTPException(status_code=404, detail=f"Unknown channel: {name}")
    return DataResponse(data=results[0])
