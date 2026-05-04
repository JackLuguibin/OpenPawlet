"""Configuration: read/write OpenPawlet ``config.json``."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request
from loguru import logger
from pydantic import ValidationError

from console.server.agent_defaults_profile_sync import (
    sync_main_workspace_agent_profile_from_config_defaults,
)
from console.server.config_apply import apply_config_change
from console.server.http_errors import bad_request, gone, internal_error
from console.server.models import (
    ConfigPutBody,
    ConfigSection,
    ConfigValidateResponse,
    DataResponse,
)
from console.server.openpawlet_user_config import (
    CONFIG_ROOT_KEYS,
    build_config_response,
    load_raw_config,
    merge_config_section,
    resolve_config_path,
    save_full_config,
    validate_core_config,
)
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
        bad_request(
            f"Invalid config file {path}: {exc}",
            cause=exc,
        )
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

    After persisting, :func:`console.server.config_apply.apply_config_change`
    schedules an in-place restart of the OpenPawlet console process so all
    layers reload from disk (no in-memory ``AgentLoop`` patching from this endpoint).
    """
    if body.section == "providers":
        gone(
            "Editing providers via /config is no longer supported. "
            "Use /api/v1/bots/{bot_id}/llm-providers instead."
        )
    path = resolve_config_path(bot_id)
    old_raw = load_raw_config(path)
    merged = merge_config_section(path, body.section, body.data)
    ok, errors = validate_core_config(merged)
    if not ok:
        bad_request("; ".join(errors) if errors else "Invalid configuration")
    try:
        save_full_config(path, merged)
    except ValidationError as exc:
        bad_request(str(exc), cause=exc)
    if body.section == "agents":
        try:
            core = {k: merged[k] for k in CONFIG_ROOT_KEYS if k in merged}
            cfg_model = Config.model_validate(core)
            sync_main_workspace_agent_profile_from_config_defaults(
                cfg_model.workspace_path,
                cfg_model.agents.defaults,
            )
        except Exception as exc:  # noqa: BLE001 — never block config save
            logger.warning(
                "[config] Could not sync primary workspace agent profile after agents save: {}",
                exc,
            )
    try:
        data = build_config_response(path)
    except ValidationError as exc:
        internal_error(str(exc), cause=exc)
    await apply_config_change(request.app, bot_id, old_raw, merged)
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
