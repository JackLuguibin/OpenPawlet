"""Post-write OpenPawlet activation for the console HTTP API.

Responsibility split
====================

* **UI (SPA)** — collect edits and call JSON APIs only; it does not write
  workspace files directly.
* **Console HTTP routers** — validate payloads and persist authoritative state
  to disk (``config.json``, ``llm_providers.json``, ``.env``, …).
* **OpenPawlet process** — after persistence succeeds, the console server
  process restarts in-place via :func:`schedule_console_process_restart`
  (same ``os.execv`` argv contract as the ``/restart`` slash command) so every
  layer—not only the embedded graph—re-reads workspace state from a cold boot.
  Bot activation still uses :func:`reload_embedded_openpawlet_runtime` /
  :func:`console.server.lifespan.swap_runtime` without a full process restart.

Handlers intentionally avoid patching live :class:`~openpawlet.agent.loop.AgentLoop`
internals (no ``apply_hot_config`` from REST): durable changes flow **disk →
restart** so persistence and runtime activation stay decoupled.
"""

from __future__ import annotations

import asyncio
import os
import sys
from typing import Any

from fastapi import FastAPI
from loguru import logger

# Coalesce multiple restart requests (e.g. SPA saves agents + tools + channels in a row).
_restart_task: asyncio.Task[None] | None = None
_RESTART_DEBOUNCE_S = 0.35


def schedule_console_process_restart(*, reason: str) -> None:
    """Re-exec this process after a short delay so the HTTP handler can finish.

    Preserves ``sys.argv[1:]`` like :func:`openpawlet.command.builtin.cmd_restart`
    so ``open-pawlet start`` resumes correctly.

    Repeated calls collapse into a single re-exec after :data:`_RESTART_DEBOUNCE_S`
    from the latest request so batched PUTs only restart once.
    """
    global _restart_task
    if os.environ.get("OPENPAWLET_SKIP_PROCESS_RESTART", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }:
        logger.debug("[console] Skipping process restart (OPENPAWLET_SKIP_PROCESS_RESTART); {}", reason)
        return
    # When tests import this module under pytest, never exec the runner process.
    if "pytest" in sys.modules:
        logger.debug("[console] Skipping process restart (pytest session); {}", reason)
        return

    async def _exec_after_debounce(last_reason: str) -> None:
        try:
            await asyncio.sleep(_RESTART_DEBOUNCE_S)
        except asyncio.CancelledError:
            return
        argv = [sys.executable, "-m", "openpawlet", *sys.argv[1:]]
        logger.info("[console] Restarting OpenPawlet process ({})", last_reason)
        os.execv(sys.executable, argv)

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        logger.warning("[console] Cannot schedule restart (no running loop); {}", reason)
        return

    if _restart_task is not None and not _restart_task.done():
        _restart_task.cancel()
    _restart_task = loop.create_task(_exec_after_debounce(reason))


async def reload_embedded_openpawlet_runtime(app: FastAPI, bot_id: str | None) -> bool:
    """Rebuild the embedded OpenPawlet runtime so it re-reads workspace files from disk."""
    from console.server.lifespan import swap_runtime

    target_bot = bot_id or getattr(app.state, "active_bot_id", None) or "default"
    return await swap_runtime(app, target_bot)


async def reload_embedded_then_broadcast_snapshots(app: FastAPI, bot_id: str | None) -> bool:
    """Schedule a full process restart after workspace writes (best-effort)."""
    _ = app
    try:
        schedule_console_process_restart(reason=f"persist:{bot_id or 'default'}")
    except Exception:  # noqa: BLE001 - never break HTTP persist handlers
        logger.opt(exception=True).warning(
            "schedule_console_process_restart failed after workspace persist"
        )
        return False
    return True


async def apply_config_change(
    app: FastAPI,
    bot_id: str | None,
    old_data: dict[str, Any],
    new_data: dict[str, Any],
) -> dict[str, Any]:
    """After ``config.json`` was saved, schedule an in-place process restart.

    The SPA saves in several ``PUT`` batches; even when merged JSON matches the
    pre-save snapshot (nothing new to persist), users still expect a cold boot after
    clicking save, so we always schedule restart here.

    Returns ``{"mode": "reload", "ok": bool}``.
    """
    _ = app
    _ = old_data, new_data
    try:
        schedule_console_process_restart(
            reason=f"config.json:{bot_id or 'default'}",
        )
    except Exception:  # noqa: BLE001
        logger.opt(exception=True).warning(
            "[config-apply] schedule_console_process_restart after config save failed"
        )
        return {"mode": "reload", "ok": False}
    return {"mode": "reload", "ok": True}


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
    """Sync ``.env`` edits into ``os.environ``, optionally mirror exec allowlist, then restart.

    When anything changed, schedules :func:`schedule_console_process_restart`
    so initialization-time readers (providers, channels, exec tool) pick up
    the new state after a cold boot (same contract as :func:`apply_config_change`).
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

    _ = app
    try:
        schedule_console_process_restart(reason=f".env:{bot_id or 'default'}")
        ok = True
    except Exception:  # noqa: BLE001 - never break the save path
        logger.exception("[config-apply] schedule restart after env change failed")
        ok = False

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
    "schedule_console_process_restart",
]
