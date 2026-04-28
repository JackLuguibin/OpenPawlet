"""Configuration: read/write OpenPawlet ``config.json``."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import ValidationError

from console.server.config_apply import apply_config_change
from console.server.models import (
    ConfigPutBody,
    ConfigSection,
    ConfigValidateResponse,
    DataResponse,
)
from console.server.openpawlet_user_config import (
    build_config_response,
    load_raw_config,
    merge_config_section,
    resolve_config_path,
    save_full_config,
    validate_core_config,
)
from console.server.state_hub_helpers import push_after_config_change
from openpawlet.config.schema import Config

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
    request: Request,
    body: ConfigPutBody,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[ConfigSection]:
    """Merge ``data`` into ``section`` and save ``config.json``.

    Writing to ``providers`` via this endpoint is rejected — provider
    credentials now live in ``llm_providers.json`` and must be edited
    via the dedicated ``/llm-providers`` API.

    After persisting, the change is forwarded to the live runtime through
    :func:`console.server.config_apply.apply_config_change` so users no
    longer need to restart the server for most edits to take effect.
    """
    if body.section == "providers":
        raise HTTPException(
            status_code=410,
            detail=(
                "Editing providers via /config is no longer supported. "
                "Use /api/v1/bots/{bot_id}/llm-providers instead."
            ),
        )
    path = resolve_config_path(bot_id)
    old_raw = load_raw_config(path)
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
    await apply_config_change(request.app, bot_id, old_raw, merged)
    push_after_config_change(bot_id)
    return DataResponse(data=ConfigSection.model_validate(data))


@router.get("/config/schema", response_model=DataResponse[Any])
async def get_config_schema(
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[Any]:
    """JSON Schema for OpenPawlet :class:`~openpawlet.config.schema.Config`."""
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
