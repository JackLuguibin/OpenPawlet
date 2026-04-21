"""Bot management API (single default instance backed by ``config.json``)."""

from __future__ import annotations

from datetime import UTC, datetime

from nanobot.utils.helpers import local_now
from pathlib import Path

from fastapi import APIRouter, HTTPException, status

from console.server.bot_workspace import (
    is_bot_running,
    set_bot_running,
    workspace_root,
)
from console.server.models import (
    CreateBotRequest,
    DataResponse,
    OkBody,
    SetDefaultBotBody,
)
from console.server.models.bots import BotInfo
from console.server.nanobot_user_config import resolve_config_path

router = APIRouter(tags=["Bots"])

_DEFAULT_BOT_ID = "default"


def _iso_mtime(path: Path) -> str:
    """Return file mtime as ISO string in the configured agent timezone."""
    ts = 0.0 if not path.exists() else path.stat().st_mtime
    instant = datetime.fromtimestamp(ts, tz=UTC)
    return instant.astimezone(local_now().tzinfo).isoformat()


def _bot_info(bot_id: str | None) -> BotInfo:
    """Build :class:`BotInfo` from nanobot config and workspace."""
    cfg_path = resolve_config_path(bot_id)
    ws = workspace_root(bot_id)
    cfg_s = str(cfg_path.resolve())
    ws_s = str(ws)
    ts = _iso_mtime(cfg_path)
    return BotInfo(
        id=_DEFAULT_BOT_ID,
        name="nanobot",
        config_path=cfg_s,
        workspace_path=ws_s,
        created_at=ts,
        updated_at=ts,
        is_default=True,
        running=is_bot_running(bot_id),
    )


@router.get("/bots", response_model=DataResponse[list[BotInfo]])
async def list_bots() -> DataResponse[list[BotInfo]]:
    """List bots (single default instance until multi-instance storage exists)."""
    return DataResponse(data=[_bot_info(None)])


@router.post(
    "/bots",
    response_model=DataResponse[BotInfo],
    status_code=status.HTTP_200_OK,
)
async def create_bot(_body: CreateBotRequest) -> DataResponse[BotInfo]:
    """Create a bot (not implemented — only one config/workspace is supported)."""
    raise HTTPException(
        status_code=501,
        detail="Multiple bot instances are not supported yet",
    )


@router.get("/bots/{bot_id}", response_model=DataResponse[BotInfo])
async def get_bot(bot_id: str) -> DataResponse[BotInfo]:
    """Return the default bot; any ``bot_id`` currently maps to the same instance."""
    _ = bot_id
    return DataResponse(data=_bot_info(None))


@router.delete("/bots/{bot_id}", response_model=DataResponse[OkBody])
async def delete_bot(bot_id: str) -> DataResponse[OkBody]:
    """Deleting the sole bot instance is not supported."""
    _ = bot_id
    raise HTTPException(
        status_code=501,
        detail="Deleting the default bot is not supported",
    )


@router.put("/bots/default", response_model=DataResponse[OkBody])
async def set_default_bot(_body: SetDefaultBotBody) -> DataResponse[OkBody]:
    """No-op while only one bot exists."""
    return DataResponse(data=OkBody())


@router.post("/bots/{bot_id}/start", response_model=DataResponse[BotInfo])
async def start_bot(bot_id: str) -> DataResponse[BotInfo]:
    """Mark bot as running in API only (no process supervisor)."""
    _ = bot_id
    set_bot_running(None, True)
    info = _bot_info(None)
    return DataResponse(data=info.model_copy(update={"running": True}))


@router.post("/bots/{bot_id}/stop", response_model=DataResponse[BotInfo])
async def stop_bot(bot_id: str) -> DataResponse[BotInfo]:
    """Mark bot as stopped in API only (no process supervisor)."""
    _ = bot_id
    set_bot_running(None, False)
    info = _bot_info(None)
    return DataResponse(data=info.model_copy(update={"running": False}))
