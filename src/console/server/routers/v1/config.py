"""Configuration: read/write nanobot ``config.json``."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query
from nanobot.config.schema import Config
from pydantic import ValidationError

from console.server.models import (
    ConfigPutBody,
    ConfigSection,
    ConfigValidateResponse,
    DataResponse,
)
from console.server.nanobot_user_config import (
    build_config_response,
    merge_config_section,
    read_default_timezone,
    resolve_config_path,
    save_full_config,
    validate_core_config,
)
from nanobot.utils.helpers import configure_process_timezone

router = APIRouter(tags=["Config"])


@router.get("/config", response_model=DataResponse[ConfigSection])
async def get_config(
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[ConfigSection]:
    """Return merged config (``config.json`` plus defaults)."""
    path = resolve_config_path(bot_id)
    try:
        data = build_config_response(path)
    except ValidationError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid config file {path}: {exc}",
        ) from exc
    return DataResponse(data=ConfigSection.model_validate(data))


@router.put("/config", response_model=DataResponse[ConfigSection])
async def put_config(
    body: ConfigPutBody,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[ConfigSection]:
    """Merge ``data`` into ``section`` and save ``config.json``."""
    path = resolve_config_path(bot_id)
    merged = merge_config_section(path, body.section, body.data)
    ok, errors = validate_core_config(merged)
    if not ok:
        raise HTTPException(
            status_code=400,
            detail="; ".join(errors) if errors else "Invalid configuration",
        )
    try:
        save_full_config(path, merged)
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        data = build_config_response(path)
    except ValidationError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    # Keep console process ``local_now`` in sync with config (no restart).
    configure_process_timezone(read_default_timezone(path))
    return DataResponse(data=ConfigSection.model_validate(data))


@router.get("/config/schema", response_model=DataResponse[Any])
async def get_config_schema(
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[Any]:
    """JSON Schema for nanobot :class:`~nanobot.config.schema.Config`."""
    _ = bot_id
    return DataResponse(data=Config.model_json_schema())


@router.post("/config/validate", response_model=DataResponse[ConfigValidateResponse])
async def validate_config(
    body: dict[str, Any],
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[ConfigValidateResponse]:
    """Validate a config object (core keys only; extras are ignored for validation)."""
    _ = bot_id
    ok, errors = validate_core_config(body)
    return DataResponse(data=ConfigValidateResponse(valid=ok, errors=errors))
