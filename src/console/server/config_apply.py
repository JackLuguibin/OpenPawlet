"""Post-write embedded runtime reload for the console HTTP API.

Responsibility split
====================

* **UI (SPA)** — collect edits and call JSON APIs only; it does not write
  workspace files directly.
* **Console HTTP routers** — validate payloads and persist authoritative state
  to disk (``config.json``, ``llm_providers.json``, ``.env``, …).
* **OpenPawlet embedded runtime** — after persistence succeeds, reload by
  rebuilding the in-process graph via :func:`reload_embedded_openpawlet_runtime`,
  which re-reads configuration from disk (same mechanism as ``swap_runtime``).
* **WebSocket state hub** — after a successful reload attempt, callers broadcast
  fresh snapshots via :func:`console.server.state_hub_helpers.push_after_config_change`
  so the SPA stays read-only over push channels (no client-side file writes).

Handlers intentionally avoid patching live :class:`~openpawlet.agent.loop.AgentLoop`
internals (no ``apply_hot_config`` from REST): durable changes always flow
**disk → reload** so persistence and runtime activation stay decoupled.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from loguru import logger


async def reload_embedded_openpawlet_runtime(app: FastAPI, bot_id: str | None) -> bool:
    """Rebuild the embedded OpenPawlet runtime so it re-reads workspace files from disk."""
    from console.server.lifespan import swap_runtime

    target_bot = bot_id or getattr(app.state, "active_bot_id", None) or "default"
    return await swap_runtime(app, target_bot)


def _broadcast_config_snapshots(bot_id: str | None) -> None:
    """Notify subscribed SPA clients that status-derived aggregates may have changed."""
    from console.server.state_hub_helpers import push_after_config_change

    push_after_config_change(bot_id)


async def reload_embedded_then_broadcast_snapshots(app: FastAPI, bot_id: str | None) -> bool:
    """Reload runtime from disk, then publish state-hub snapshots (reload is best-effort)."""
    try:
        ok = await reload_embedded_openpawlet_runtime(app, bot_id)
    except Exception:  # noqa: BLE001 - never break HTTP persist handlers
        logger.opt(exception=True).debug(
            "reload_embedded_openpawlet_runtime failed after workspace persist"
        )
        ok = False
    _broadcast_config_snapshots(bot_id)
    return bool(ok)


async def apply_config_change(
    app: FastAPI,
    bot_id: str | None,
    old_data: dict[str, Any],
    new_data: dict[str, Any],
) -> dict[str, Any]:
    """After ``config.json`` was saved, reload the embedded runtime from disk.

    Also broadcasts status/channel/MCP snapshots for WebSocket subscribers.

    Returns ``{"mode": "noop"|"reload", "ok": bool}``.
    """
    if old_data == new_data:
        return {"mode": "noop", "ok": True}

    ok = await reload_embedded_openpawlet_runtime(app, bot_id)
    _broadcast_config_snapshots(bot_id)
    return {"mode": "reload", "ok": bool(ok)}


def _sync_exec_allowed_env_keys(
    bot_id: str | None,
    new_vars: dict[str, str],
    exec_visible_keys: list[str] | None,
) -> bool:
    """Mirror the user's "allow exec" toggles into ``tools.exec.allowedEnvKeys``.

    The exec tool builds a strict env allowlist for sandboxed subprocesses
    (see :class:`openpawlet.agent.tools.shell.ExecTool._build_env`); without
    this sync, env vars added through the UI would never be visible to
    ``exec`` calls even after ``os.environ`` has been updated.

    Returns ``True`` when the on-disk config was rewritten so callers can
    decide whether they need to refresh dependent caches.
    """
    if exec_visible_keys is None:
        return False

    from console.server.openpawlet_user_config import (
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
    """Sync ``.env`` edits into ``os.environ``, optionally mirror exec allowlist, then reload runtime.

    Always invokes :func:`reload_embedded_openpawlet_runtime` when anything
    changed so initialization-time readers (providers, channels, exec tool)
    pick up the new state from disk and environment, then broadcast the same
    state-hub snapshots as :func:`apply_config_change`.
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

    try:
        ok = await reload_embedded_openpawlet_runtime(app, bot_id)
    except Exception:  # noqa: BLE001 - never break the save path
        logger.exception("[config-apply] reload after env change failed")
        ok = False

    _broadcast_config_snapshots(bot_id)

    return {
        "added": added,
        "updated": updated,
        "removed": removed,
        "exec_allowlist_changed": exec_allowlist_changed,
        "swap_ok": bool(ok),
    }


__all__ = [
    "apply_config_change",
    "apply_env_change",
    "reload_embedded_openpawlet_runtime",
    "reload_embedded_then_broadcast_snapshots",
]
