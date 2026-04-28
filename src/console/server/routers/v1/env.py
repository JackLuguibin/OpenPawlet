"""Environment variables: read/write ``.env`` beside ``config.json``.

Saves are forwarded through :func:`console.server.config_apply.apply_env_change`
so users no longer need to restart the bot after editing a variable —
the new value is mirrored into ``os.environ`` immediately and the
embedded runtime is rebuilt so initialisation-time consumers
(providers, channels, agent identity) re-read the latest state.

The ``exec_visible_keys`` payload mirrors the user's per-row "allow exec"
toggles into ``tools.exec.allowedEnvKeys``, which controls whether the
exec tool's sandboxed subprocess receives each variable.  Without that
toggle, env vars added through the UI would never be visible to ``exec``
calls because the exec tool deliberately starts subprocesses with a
strict allowlisted environment.
"""

from __future__ import annotations

from fastapi import APIRouter, Query, Request

from console.server.config_apply import apply_env_change
from console.server.models import DataResponse
from console.server.models.env import EnvPutBody, EnvPutResponse, EnvResponse
from console.server.nanobot_user_config import (
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
    """Replace ``.env`` with the given key/value map and apply hot.

    On-disk ``.env`` is overwritten first (the source of truth for
    subsequent restarts), then the diff against the previous file is
    mirrored into ``os.environ``, ``tools.exec.allowedEnvKeys`` is
    updated to match ``exec_visible_keys``, and the embedded runtime is
    rebuilt so the change is observable without a manual bot restart.
    """
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
