"""Bot profile files (SOUL, USER, …) stored as markdown in the workspace root."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from console.server.bot_workspace import (
    profile_file_path,
    read_text,
    write_text,
)
from console.server.models import (
    BotFilesResponse,
    BotFileUpdateBody,
    DataResponse,
)
from console.server.models.base import OkWithKey

router = APIRouter(tags=["BotFiles"])


@router.get("/bot-files", response_model=DataResponse[BotFilesResponse])
async def get_bot_files(
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[BotFilesResponse]:
    """Return bootstrap markdown files from the workspace root."""
    keys: tuple[str, ...] = ("soul", "user", "heartbeat", "tools", "agents")
    parts: dict[str, str] = {}
    for key in keys:
        path = profile_file_path(bot_id, key)
        parts[key] = read_text(path) if path.is_file() else ""
    return DataResponse(data=BotFilesResponse(**parts))


@router.put("/bot-files/{key}", response_model=DataResponse[OkWithKey])
async def update_bot_file(
    key: str,
    body: BotFileUpdateBody,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[OkWithKey]:
    """Write one bootstrap file under the workspace root."""
    if key not in ("soul", "user", "heartbeat", "tools", "agents"):
        raise HTTPException(status_code=400, detail="Unknown profile key")
    path = profile_file_path(bot_id, key)
    write_text(path, body.content)
    return DataResponse(data=OkWithKey(key=key))
