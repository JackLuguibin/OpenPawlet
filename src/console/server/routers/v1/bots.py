"""Bot management API backed by the multi-instance registry."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Request, status

from console.server.bot_workspace import (
    is_bot_running,
    set_bot_running,
    workspace_root,
)
from console.server.bots_registry import DEFAULT_BOT_ID, get_registry
from console.server.http_errors import bad_request, not_found, service_unavailable
from console.server.models import (
    CreateBotRequest,
    DataResponse,
    OkBody,
    SetDefaultBotBody,
)
from console.server.models.bots import BotInfo
from console.server.openpawlet_user_config import read_default_timezone, resolve_config_path
from console.server.state_hub import publish_bots_update
from openpawlet.utils.helpers import local_now

router = APIRouter(tags=["Bots"])


def _require_registered_bot(bot_id: str) -> None:
    if get_registry().get(bot_id) is None:
        not_found("Bot")


def _iso_mtime(path: Path, iana_tz: str | None) -> str:
    """Return file mtime as ISO string in the configured agent timezone."""
    ts = 0.0 if not path.exists() else path.stat().st_mtime
    instant = datetime.fromtimestamp(ts, tz=UTC)
    return instant.astimezone(local_now(iana_tz).tzinfo).isoformat()


def _bot_info(bot_id: str | None) -> BotInfo:
    """Build :class:`BotInfo` from registry row + OpenPawlet config."""
    registry = get_registry()
    target_id = bot_id or registry.default_id()
    row = registry.get(target_id) or registry.get(DEFAULT_BOT_ID)
    if row is None:
        # Should never happen: list() always seeds the default, but be
        # defensive in case the registry file is inconsistent.
        cfg_path = resolve_config_path(None)
        ws = workspace_root(None)
        ts = _iso_mtime(cfg_path, read_default_timezone(cfg_path))
        return BotInfo(
            id=DEFAULT_BOT_ID,
            name="openpawlet",
            config_path=str(cfg_path.resolve()),
            workspace_path=str(ws),
            created_at=ts,
            updated_at=ts,
            is_default=True,
            running=is_bot_running(None),
        )
    cfg_path = Path(str(row["config_path"]))
    iana = read_default_timezone(cfg_path)
    ts = _iso_mtime(cfg_path, iana)
    created_at = str(row.get("created_at") or ts)
    return BotInfo(
        id=str(row["id"]),
        name=str(row.get("name") or row["id"]),
        config_path=str(cfg_path.resolve()),
        workspace_path=str(Path(str(row["workspace_path"])).resolve()),
        created_at=created_at,
        updated_at=ts,
        is_default=(str(row["id"]) == registry.default_id()),
        running=is_bot_running(row["id"] if row["id"] != DEFAULT_BOT_ID else None),
    )


@router.get("/bots", response_model=DataResponse[list[BotInfo]])
async def list_bots() -> DataResponse[list[BotInfo]]:
    """List all registered bot instances."""
    rows = get_registry().list()
    return DataResponse(data=[_bot_info(r["id"]) for r in rows])


@router.post(
    "/bots",
    response_model=DataResponse[BotInfo],
    status_code=status.HTTP_200_OK,
)
async def create_bot(body: CreateBotRequest) -> DataResponse[BotInfo]:
    """Create a new bot instance with its own config + workspace."""
    name = (getattr(body, "name", None) or "").strip()
    if not name:
        bad_request("name is required")
    try:
        row = get_registry().add(name=name)
    except ValueError as exc:
        bad_request(str(exc))
    publish_bots_update()
    return DataResponse(data=_bot_info(row["id"]))


@router.get("/bots/{bot_id}", response_model=DataResponse[BotInfo])
async def get_bot(bot_id: str) -> DataResponse[BotInfo]:
    """Return one bot by id."""
    _require_registered_bot(bot_id)
    return DataResponse(data=_bot_info(bot_id))


@router.delete("/bots/{bot_id}", response_model=DataResponse[OkBody])
async def delete_bot(bot_id: str) -> DataResponse[OkBody]:
    """Remove a non-default bot instance."""
    try:
        removed = get_registry().remove(bot_id)
    except ValueError as exc:
        bad_request(str(exc))
    if not removed:
        not_found("Bot")
    publish_bots_update()
    return DataResponse(data=OkBody())


@router.put("/bots/default", response_model=DataResponse[OkBody])
async def set_default_bot(body: SetDefaultBotBody) -> DataResponse[OkBody]:
    """Switch which bot is treated as default for ``bot_id`` omission."""
    target = (getattr(body, "bot_id", None) or "").strip()
    if not target:
        bad_request("bot_id is required")
    if not get_registry().set_default(target):
        not_found("Bot")
    publish_bots_update()
    return DataResponse(data=OkBody())


@router.post("/bots/{bot_id}/start", response_model=DataResponse[BotInfo])
async def start_bot(bot_id: str) -> DataResponse[BotInfo]:
    """Mark bot as running in API only (no process supervisor in P3a)."""
    _require_registered_bot(bot_id)
    set_bot_running(bot_id if bot_id != DEFAULT_BOT_ID else None, True)
    info = _bot_info(bot_id)
    return DataResponse(data=info.model_copy(update={"running": True}))


@router.post("/bots/{bot_id}/stop", response_model=DataResponse[BotInfo])
async def stop_bot(bot_id: str) -> DataResponse[BotInfo]:
    """Mark bot as stopped in API only (no process supervisor in P3a)."""
    _require_registered_bot(bot_id)
    set_bot_running(bot_id if bot_id != DEFAULT_BOT_ID else None, False)
    info = _bot_info(bot_id)
    return DataResponse(data=info.model_copy(update={"running": False}))


@router.post("/bots/{bot_id}/activate", response_model=DataResponse[BotInfo])
async def activate_bot(bot_id: str, request: Request) -> DataResponse[BotInfo]:
    """Swap the embedded runtime over to *bot_id*.

    The console hosts a single in-process runtime at a time; activating
    a different bot stops the current one and starts a fresh runtime
    targeting the requested bot's config + workspace.  This is a brief
    restart - WS clients reconnect automatically.
    """
    from console.server.app import swap_runtime

    _require_registered_bot(bot_id)
    ok = await swap_runtime(request.app, bot_id)
    if not ok:
        service_unavailable("Runtime swap failed; console is in degraded mode")
    return DataResponse(data=_bot_info(bot_id))
