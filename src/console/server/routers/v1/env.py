"""Environment variables: read/write ``.env`` beside ``config.json``.

Saves are forwarded through :func:`console.server.config_apply.apply_env_change`
which mirrors values into ``os.environ``, persists derived ``config.json``
(exec allowlist) when needed, reloads the embedded runtime from disk plus
environment, and broadcasts SPA snapshots — without requiring a manual
process restart.

``exec_visible_keys`` from the UI selects which loaded vars are mirrored into
``tools.exec.allowedEnvKeys`` so the exec subprocess environment matches toggles.
"""

from __future__ import annotations

from fastapi import APIRouter, Query, Request

from console.server.config_apply import apply_env_change
from console.server.models import DataResponse
from console.server.models.env import EnvPutBody, EnvPutResponse, EnvResponse
from console.server.openpawlet_user_config import (
    env_file_path,
    load_raw_config,
    parse_dotenv_file,
    resolve_config_path,
    write_dotenv_file,
)

router = APIRouter(tags=["Env"])


def _read_exec_allowlist(bot_id: str | None) -> list[str]:
    """Return the current ``tools.exec.allowedEnvKeys`` for *bot_id*."""
    raw = load_raw_config(resolve_config_path(bot_id))
    tools = raw.get("tools") or {}
    exec_cfg = tools.get("exec") or {}
    keys = exec_cfg.get("allowedEnvKeys") or exec_cfg.get("allowed_env_keys") or []
    if not isinstance(keys, list):
        return []
    return [str(k) for k in keys]


@router.get("/env", response_model=DataResponse[EnvResponse])
async def get_env(
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[EnvResponse]:
    """Return ``.env`` content plus the keys forwarded to the exec tool."""
    path = env_file_path(bot_id)
    vars_map = parse_dotenv_file(path)
    allowlist = _read_exec_allowlist(bot_id)
    visible = [k for k in allowlist if k in vars_map]
    return DataResponse(
        data=EnvResponse(vars=vars_map, exec_visible_keys=visible)
    )


@router.put("/env", response_model=DataResponse[EnvPutResponse])
async def put_env(
    request: Request,
    body: EnvPutBody,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[EnvPutResponse]:
    """Replace ``.env``, mirror ``os.environ``, persist exec allowlist, reload embedded runtime, broadcast SPA snapshots."""
    path = env_file_path(bot_id)
    old_vars = parse_dotenv_file(path)
    write_dotenv_file(path, body.vars)
    await apply_env_change(
        request.app,
        bot_id,
        old_vars,
        body.vars,
        body.exec_visible_keys,
    )
    visible = [k for k in _read_exec_allowlist(bot_id) if k in body.vars]
    return DataResponse(
        data=EnvPutResponse(status="ok", vars=body.vars, exec_visible_keys=visible)
    )
