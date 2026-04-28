"""Apply ``config.json`` changes to the live runtime without restarts.

Save endpoints (``PUT /api/v1/config`` and the LLM-providers routes)
forward each save through :func:`apply_config_change`. The helper inspects
the diff between the previous and the new on-disk config and decides per
field whether a hot-apply is sufficient or whether the embedded nanobot
runtime must be rebuilt via :func:`console.server.lifespan.swap_runtime`.

Hot-apply contract
==================

* In-flight requests/sessions keep using the values they captured when
  they started; only **new** turns / new sessions started after the call
  observe the new configuration.
* Anything that requires re-instantiating tools, channels, MCP clients
  or the LLM provider falls into the "needs swap" bucket.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from loguru import logger

from nanobot.config.schema import Config

if TYPE_CHECKING:
    from fastapi import FastAPI


# Top-level config sections whose changes we currently cannot apply
# without rebuilding the embedded runtime (channels rewire bus + outbound,
# tools.web/exec/mcp are baked into ToolRegistry, restrict_to_workspace
# drives sandbox decisions captured at tool-construction time).
_SWAP_REQUIRED_TOP_LEVEL = ("channels", "gateway", "api")
_SWAP_REQUIRED_TOOLS_KEYS = ("web", "exec", "mcp_servers", "mcpServers", "restrictToWorkspace", "restrict_to_workspace", "my")


def _normalize(data: dict[str, Any] | None) -> dict[str, Any]:
    """Return a Config-validated, alias-normalised copy of ``data``.

    Falls back to defaults on validation errors so a save endpoint can
    still apply the safe subset (the endpoint validates the user input
    before this function is reached, so failures here are not expected).
    """
    if not data:
        return Config().model_dump(mode="json", by_alias=True)
    try:
        cfg = Config.model_validate(
            {k: data[k] for k in ("agents", "channels", "tools", "api", "gateway") if k in data}
        )
    except Exception:  # noqa: BLE001 - normalise into defaults on bad input
        return Config().model_dump(mode="json", by_alias=True)
    return cfg.model_dump(mode="json", by_alias=True)


def needs_runtime_swap(old: dict[str, Any], new: dict[str, Any]) -> bool:
    """Return True when *new* differs from *old* in a non-hot-swappable way."""
    old_n = _normalize(old)
    new_n = _normalize(new)

    for key in _SWAP_REQUIRED_TOP_LEVEL:
        if old_n.get(key) != new_n.get(key):
            return True

    old_tools = old_n.get("tools") or {}
    new_tools = new_n.get("tools") or {}
    for key in _SWAP_REQUIRED_TOOLS_KEYS:
        if old_tools.get(key) != new_tools.get(key):
            return True

    return False


def _apply_ssrf_whitelist(new_cfg: Config) -> None:
    """Re-publish the SSRF whitelist; safe to call repeatedly."""
    from nanobot.security.network import configure_ssrf_whitelist

    configure_ssrf_whitelist(new_cfg.tools.ssrf_whitelist)


def hot_apply(app: FastAPI, new_cfg: Config) -> dict[str, Any]:
    """Apply hot-swappable fields of ``new_cfg`` to the running runtime.

    Returns a mapping describing what was changed (mostly for logs and
    tests). Missing/inactive runtimes return an empty dict so callers can
    treat "degraded mode" as a no-op without special-casing.
    """
    _apply_ssrf_whitelist(new_cfg)

    embedded = getattr(app.state, "embedded", None)
    if embedded is None:
        return {}

    agent = getattr(embedded, "agent", None)
    if agent is None or not hasattr(agent, "apply_hot_config"):
        return {}

    try:
        return agent.apply_hot_config(new_cfg)
    except Exception:  # noqa: BLE001 - never break the save path on hot-apply
        logger.exception("[config-apply] hot-apply failed; runtime kept previous values")
        return {}


async def apply_config_change(
    app: FastAPI,
    bot_id: str | None,
    old_data: dict[str, Any],
    new_data: dict[str, Any],
) -> dict[str, Any]:
    """Decide between hot-apply and runtime-swap for a config save.

    Returns a small dict with ``{"mode": "hot"|"swap"|"noop", "changed": ...}``
    so the API layer can include it in its log line if it wants to.
    """
    if old_data == new_data:
        return {"mode": "noop", "changed": {}}

    if needs_runtime_swap(old_data, new_data):
        from console.server.lifespan import swap_runtime

        target_bot = bot_id or getattr(app.state, "active_bot_id", None) or "default"
        ok = await swap_runtime(app, target_bot)
        return {"mode": "swap", "ok": bool(ok)}

    try:
        new_cfg = Config.model_validate(
            {k: new_data[k] for k in ("agents", "channels", "tools", "api", "gateway") if k in new_data}
        )
    except Exception:  # noqa: BLE001
        logger.exception("[config-apply] new config failed validation; skipping hot-apply")
        return {"mode": "noop", "changed": {}}

    changed = hot_apply(app, new_cfg)
    return {"mode": "hot", "changed": changed}


def _sync_exec_allowed_env_keys(
    bot_id: str | None,
    new_vars: dict[str, str],
    exec_visible_keys: list[str] | None,
) -> bool:
    """Mirror the user's "allow exec" toggles into ``tools.exec.allowedEnvKeys``.

    The exec tool builds a strict env allowlist for sandboxed subprocesses
    (see :class:`nanobot.agent.tools.shell.ExecTool._build_env`); without
    this sync, env vars added through the UI would never be visible to
    ``exec`` calls even after ``os.environ`` has been updated.

    Returns ``True`` when the on-disk config was rewritten so callers can
    decide whether they need to refresh dependent caches.
    """
    if exec_visible_keys is None:
        return False

    from console.server.nanobot_user_config import (
        load_raw_config,
        resolve_config_path,
        save_full_config,
    )

    desired = sorted({k for k in exec_visible_keys if k in new_vars})

    path = resolve_config_path(bot_id)
    raw = load_raw_config(path)
    tools = raw.setdefault("tools", {})
    exec_cfg = tools.setdefault("exec", {})
    current = exec_cfg.get("allowedEnvKeys") or exec_cfg.get("allowed_env_keys") or []
    if isinstance(current, list):
        current_sorted = sorted({str(k) for k in current})
    else:
        current_sorted = []

    if current_sorted == desired:
        return False

    # Drop both spellings to avoid duplicate keys after merge; the schema
    # serialises as ``allowedEnvKeys`` (camelCase) consistently.
    exec_cfg.pop("allowedEnvKeys", None)
    exec_cfg.pop("allowed_env_keys", None)
    exec_cfg["allowedEnvKeys"] = desired
    try:
        save_full_config(path, raw)
    except Exception:  # noqa: BLE001 - keep .env save successful even if config write fails
        logger.exception("[config-apply] failed to update tools.exec.allowedEnvKeys")
        return False
    return True


async def apply_env_change(
    app: FastAPI,
    bot_id: str | None,
    old_vars: dict[str, str],
    new_vars: dict[str, str],
    exec_visible_keys: list[str] | None = None,
) -> dict[str, Any]:
    """Sync ``.env`` edits into ``os.environ`` and rebuild the runtime.

    Three effects:
    * Keys present in *new_vars* (added or updated) are written into
      ``os.environ`` so any subsequent code path that reads via
      ``os.environ.get(...)`` immediately observes the new value.
    * Keys removed from *new_vars* are deleted from ``os.environ`` so the
      "I removed it from the UI" intent is honoured.
    * When *exec_visible_keys* is not ``None``, the matching subset is
      written to ``tools.exec.allowedEnvKeys`` so the exec tool's
      sandboxed subprocess env honours the user's toggles.

    A ``swap_runtime`` is then invoked so initialisation-time consumers
    (provider factories, channel bootstrap, agent ID resolution, exec
    tool with the new allowlist, etc.) re-read environment variables
    under the new state.

    Returns ``{"added": [...], "updated": [...], "removed": [...],
    "exec_allowlist_changed": bool, "swap_ok": bool}`` for tests/logs.
    """
    import os

    added: list[str] = []
    updated: list[str] = []
    for key, value in new_vars.items():
        previous = old_vars.get(key)
        if previous is None:
            added.append(key)
        elif previous != value:
            updated.append(key)
        os.environ[key] = value

    removed: list[str] = []
    for key in old_vars.keys():
        if key not in new_vars:
            removed.append(key)
            os.environ.pop(key, None)

    exec_allowlist_changed = _sync_exec_allowed_env_keys(
        bot_id, new_vars, exec_visible_keys
    )

    if not (added or updated or removed or exec_allowlist_changed):
        return {
            "added": [],
            "updated": [],
            "removed": [],
            "exec_allowlist_changed": False,
            "swap_ok": True,
        }

    # Always rebuild the embedded runtime so initialisation-time consumers
    # (channels, providers, agent identity, exec tool's frozen allowlist)
    # pick up the new state. The exec allowlist in particular is captured
    # by ``ExecTool.__init__`` so a hot field assignment would not help.
    from console.server.lifespan import swap_runtime

    target_bot = bot_id or getattr(app.state, "active_bot_id", None) or "default"
    try:
        ok = await swap_runtime(app, target_bot)
    except Exception:  # noqa: BLE001 - never break the save path
        logger.exception("[config-apply] swap_runtime after env change failed")
        ok = False

    return {
        "added": added,
        "updated": updated,
        "removed": removed,
        "exec_allowlist_changed": exec_allowlist_changed,
        "swap_ok": bool(ok),
    }


def apply_providers_change(app: FastAPI) -> bool:
    """Rebuild and hot-swap the LLM provider used by the live runtime.

    Called by the ``/llm-providers`` endpoints so changes to default
    instance / API keys / failover settings take effect on the next LLM
    call without a restart.

    Returns ``True`` when a new provider was installed, ``False`` when
    the runtime is missing (degraded mode) or rebuild failed.
    """
    embedded = getattr(app.state, "embedded", None)
    if embedded is None:
        return False
    agent = getattr(embedded, "agent", None)
    if agent is None or not hasattr(agent, "replace_provider"):
        return False

    try:
        from nanobot.config.loader import load_config, resolve_config_env_vars
        from nanobot.providers.factory import build_default_provider

        cfg = resolve_config_env_vars(load_config())
        new_provider = build_default_provider(cfg)
    except Exception:  # noqa: BLE001 - never break the save path
        logger.exception("[config-apply] failed to rebuild LLM provider")
        return False

    try:
        agent.replace_provider(new_provider)
    except Exception:  # noqa: BLE001
        logger.exception("[config-apply] replace_provider failed")
        return False
    return True


__all__ = [
    "apply_config_change",
    "apply_env_change",
    "apply_providers_change",
    "hot_apply",
    "needs_runtime_swap",
]
