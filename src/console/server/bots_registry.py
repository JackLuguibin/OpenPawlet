"""Multi-instance bot registry persisted under ``~/.nanobot/registry.json``.

The console historically supported a single nanobot config at
``~/.nanobot/config.json``.  Adding multi-instance support lazily would
mean every router that reads workspace state needs to know which bot it
is operating on.  We instead introduce a single entry point - the
:class:`BotsRegistry` - that maps an opaque ``bot_id`` to a per-bot
config file and workspace directory.  The legacy single-bot layout
remains available as the implicit ``default`` entry so existing
installations keep working without migration.

Layout::

    ~/.nanobot/
        registry.json                  # {"bots": [...], "default": "default"}
        config.json                    # legacy single-bot config (treated as
                                       # the implicit "default" bot)
        bots/
            <bot_id>/
                config.json
                workspace/             # per-bot workspace root

Per-bot ``config.json`` files inherit from the legacy schema; only the
``workspace_path`` field is rewritten on ``add()`` so the bot owns its
own workspace tree.
"""

from __future__ import annotations

import json
import shutil
import uuid
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock
from typing import Any

from filelock import FileLock
from loguru import logger

DEFAULT_BOT_ID = "default"


def _nanobot_root() -> Path:
    """Return ``~/.nanobot`` (created on demand)."""
    root = Path.home() / ".nanobot"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _registry_path() -> Path:
    return _nanobot_root() / "registry.json"


def _bots_root() -> Path:
    return _nanobot_root() / "bots"


def _legacy_config_path() -> Path:
    return _nanobot_root() / "config.json"


class BotsRegistry:
    """In-memory view of the persisted bot registry.

    The class is intentionally small: it owns the JSON file schema, the
    on-disk layout under ``bots/<id>/`` and the bookkeeping needed by the
    HTTP handlers.  Runtime lifecycle (per-bot ``EmbeddedNanobot``
    instances) is layered on top of this in P3b.
    """

    def __init__(self, root: Path | None = None) -> None:
        self._root = root if root is not None else _nanobot_root()
        self._lock = RLock()
        self._file_lock = FileLock(str(self._root / "registry.json.lock"))

    # ---- persistence ---------------------------------------------------
    def _load(self) -> dict[str, Any]:
        path = self._root / "registry.json"
        if not path.exists():
            return {"bots": [], "default": DEFAULT_BOT_ID}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("[bots_registry] bad registry.json: {}", exc)
            return {"bots": [], "default": DEFAULT_BOT_ID}
        if not isinstance(data, dict):
            return {"bots": [], "default": DEFAULT_BOT_ID}
        bots = data.get("bots")
        default_id = data.get("default") or DEFAULT_BOT_ID
        return {
            "bots": list(bots) if isinstance(bots, list) else [],
            "default": str(default_id),
        }

    def _save(self, state: dict[str, Any]) -> None:
        path = self._root / "registry.json"
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)

    # ---- helpers -------------------------------------------------------
    @staticmethod
    def _row(
        bot_id: str,
        name: str,
        config_path: Path,
        workspace_path: Path,
        created_at: str,
    ) -> dict[str, Any]:
        return {
            "id": bot_id,
            "name": name,
            "config_path": str(config_path.resolve()),
            "workspace_path": str(workspace_path.resolve()),
            "created_at": created_at,
        }

    def _seed_default_if_missing(self, state: dict[str, Any]) -> dict[str, Any]:
        """Make sure the implicit ``default`` bot is present in the registry.

        For backwards compatibility we never auto-rewrite the legacy
        ``~/.nanobot/config.json``; we just expose it as a read-only
        ``default`` entry so the SPA can render it like any other bot.
        """
        if any(b.get("id") == DEFAULT_BOT_ID for b in state["bots"]):
            return state
        legacy_cfg = _legacy_config_path()
        # Deliberately do not point the default bot at a per-bot directory;
        # callers that need workspace_root() resolve it from the legacy
        # config to preserve historical behaviour.
        ws = self._read_workspace_from_config(legacy_cfg) or _nanobot_root() / "workspace"
        state["bots"].insert(
            0,
            self._row(
                DEFAULT_BOT_ID,
                "default",
                legacy_cfg,
                ws,
                _isoformat_now(),
            ),
        )
        return state

    @staticmethod
    def _read_workspace_from_config(path: Path) -> Path | None:
        if not path.exists():
            return None
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(raw, dict):
            return None
        ws = raw.get("workspace") or raw.get("workspacePath")
        return Path(str(ws)).expanduser() if isinstance(ws, str) and ws else None

    # ---- public API ----------------------------------------------------
    def list(self) -> list[dict[str, Any]]:
        with self._lock, self._file_lock:
            state = self._seed_default_if_missing(self._load())
            return list(state["bots"])

    def get(self, bot_id: str) -> dict[str, Any] | None:
        for row in self.list():
            if row.get("id") == bot_id:
                return row
        return None

    def default_id(self) -> str:
        with self._lock, self._file_lock:
            state = self._seed_default_if_missing(self._load())
            return str(state.get("default") or DEFAULT_BOT_ID)

    def add(self, *, name: str, bot_id: str | None = None) -> dict[str, Any]:
        """Create a new bot with its own config + workspace."""
        new_id = (bot_id or f"bot-{uuid.uuid4().hex[:8]}").strip()
        if not new_id or new_id == DEFAULT_BOT_ID:
            raise ValueError("bot_id must be non-empty and not 'default'")
        with self._lock, self._file_lock:
            state = self._seed_default_if_missing(self._load())
            if any(b.get("id") == new_id for b in state["bots"]):
                raise ValueError(f"bot id already exists: {new_id}")

            bot_dir = _bots_root() / new_id
            ws_dir = bot_dir / "workspace"
            cfg_path = bot_dir / "config.json"
            ws_dir.mkdir(parents=True, exist_ok=True)

            # Seed config: copy the legacy default if present, else
            # create a minimal placeholder.  In both cases overwrite the
            # workspace path so the new bot owns its own tree.
            base_cfg: dict[str, Any] = {}
            legacy = _legacy_config_path()
            if legacy.exists():
                try:
                    base_cfg = json.loads(legacy.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    base_cfg = {}
                    logger.warning("[bots_registry] could not seed from legacy config")
            if not isinstance(base_cfg, dict):
                base_cfg = {}
            base_cfg["workspace"] = str(ws_dir.resolve())
            cfg_path.write_text(
                json.dumps(base_cfg, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )

            row = self._row(new_id, name.strip() or new_id, cfg_path, ws_dir, _isoformat_now())
            state["bots"].append(row)
            self._save(state)
            return row

    def remove(self, bot_id: str) -> bool:
        """Remove a non-default bot and tear down its on-disk state."""
        if bot_id == DEFAULT_BOT_ID:
            raise ValueError("cannot remove the implicit default bot")
        with self._lock, self._file_lock:
            state = self._seed_default_if_missing(self._load())
            kept = [b for b in state["bots"] if b.get("id") != bot_id]
            if len(kept) == len(state["bots"]):
                return False
            state["bots"] = kept
            if state.get("default") == bot_id:
                state["default"] = DEFAULT_BOT_ID
            self._save(state)
            target_dir = _bots_root() / bot_id
            if target_dir.exists():
                # Best-effort: a stuck handle should not prevent the
                # registry update; the directory will linger and the
                # caller can retry deletion later.
                try:
                    shutil.rmtree(target_dir)
                except OSError as exc:
                    logger.warning(
                        "[bots_registry] could not remove {}: {}",
                        target_dir,
                        exc,
                    )
            return True

    def set_default(self, bot_id: str) -> bool:
        with self._lock, self._file_lock:
            state = self._seed_default_if_missing(self._load())
            if not any(b.get("id") == bot_id for b in state["bots"]):
                return False
            state["default"] = bot_id
            self._save(state)
            return True

    def resolve_config_path(self, bot_id: str | None) -> Path:
        """Return the on-disk config.json path for *bot_id*.

        Falls back to the legacy ``~/.nanobot/config.json`` when *bot_id*
        is missing or unknown so single-bot deployments keep working with
        no migration required.
        """
        if not bot_id or bot_id == DEFAULT_BOT_ID:
            return _legacy_config_path()
        row = self.get(bot_id)
        if row is None:
            return _legacy_config_path()
        return Path(str(row["config_path"]))


def _isoformat_now() -> str:
    return datetime.now(tz=UTC).isoformat()


# Module-level singleton so all routers share a consistent view.  Tests
# can override the registry root by monkeypatching ``_DEFAULT_REGISTRY``
# before importing dependent modules.
_DEFAULT_REGISTRY: BotsRegistry | None = None


def get_registry() -> BotsRegistry:
    global _DEFAULT_REGISTRY
    if _DEFAULT_REGISTRY is None:
        _DEFAULT_REGISTRY = BotsRegistry()
    return _DEFAULT_REGISTRY


__all__ = [
    "DEFAULT_BOT_ID",
    "BotsRegistry",
    "get_registry",
]
