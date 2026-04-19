"""Environment variables: read/write ``.env`` beside ``config.json``."""

from __future__ import annotations

from fastapi import APIRouter, Query

from console.server.models import DataResponse
from console.server.models.env import EnvPutBody, EnvPutResponse, EnvResponse
from console.server.nanobot_user_config import (
    env_file_path,
    parse_dotenv_file,
    write_dotenv_file,
)

router = APIRouter(tags=["Env"])


@router.get("/env", response_model=DataResponse[EnvResponse])
async def get_env(
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[EnvResponse]:
    """Return variables from ``.env`` next to the nanobot config file."""
    path = env_file_path(bot_id)
    return DataResponse(data=EnvResponse(vars=parse_dotenv_file(path)))


@router.put("/env", response_model=DataResponse[EnvPutResponse])
async def put_env(
    body: EnvPutBody,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[EnvPutResponse]:
    """Replace ``.env`` with the given key/value map."""
    path = env_file_path(bot_id)
    write_dotenv_file(path, body.vars)
    return DataResponse(data=EnvPutResponse(status="ok", vars=body.vars))
