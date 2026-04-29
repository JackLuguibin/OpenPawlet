"""User-facing ``config.json`` load/save for the console API."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from loguru import logger
from pydantic import ValidationError

from openpawlet.config.loader import migrate_config
from openpawlet.config.schema import Config

CONFIG_ROOT_KEYS = frozenset({"agents", "channels", "providers", "api", "gateway", "tools"})

# Shared OpenAPI description for the optional ``bot_id`` query parameter.
# The console is currently single-instance (one ``~/.openpawlet/config.json``);
# ``bot_id`` is kept as a parameter on every bot-scoped route so the REST
# surface is stable once per-bot storage lands, but it is **ignored today**.
BOT_ID_DESCRIPTION = (
    "Reserved for future multi-instance support. Currently ignored; the "
    "console always operates against the single agent config under "
    "``~/.openpawlet/config.json``."
)


def resolve_config_path(bot_id: str | None) -> Path:
    """Return ``config.json`` path for the given bot.

    Resolves through :func:`console.server.bots_registry.get_registry` so
    callers transparently get the right per-bot file when multi-instance
    is in use.  Falls back to the legacy ``~/.openpawlet/config.json`` when
    *bot_id* is unset or unknown so single-bot deployments work without
    any migration.

    Args:
        bot_id: Optional bot identifier; ``None`` selects the default.

    Returns:
        Absolute path to the JSON config file.
    """
    from console.server.bots_registry import get_registry

    return get_registry().resolve_config_path(bot_id)


def deep_merge(base: dict[str, Any], update: dict[str, Any]) -> dict[str, Any]:
    """Recursively merge ``update`` into ``base`` (neither input is mutated)."""
    result = dict(base)
    for key, value in update.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def load_raw_config(path: Path) -> dict[str, Any]:
    """Load JSON from ``path`` and apply OpenPawlet config migrations."""
    if not path.exists():
        return {}
    try:
        with path.open(encoding="utf-8") as f:
            data: Any = json.load(f)
    except json.JSONDecodeError as exc:
        logger.warning("[config] Invalid JSON in {}: {}", path, exc)
        return {}
    if not isinstance(data, dict):
        return {}
    return migrate_config(data)


def merge_config_section(
    path: Path,
    section: str,
    patch: dict[str, Any],
) -> dict[str, Any]:
    """Return the full merged config after applying ``patch`` under ``section``."""
    raw = load_raw_config(path)
    section_base = raw.get(section)
    if not isinstance(section_base, dict):
        section_base = {}
    merged_section = deep_merge(section_base, patch)
    # ``mcpServers`` is a map of server id -> config. A deep-merge would keep
    # removed server ids when the SPA sends the full current map; replacing the
    # key wholesale matches editor semantics (same for legacy ``mcp_servers``).
    if section == "tools":
        if "mcpServers" in patch and isinstance(patch["mcpServers"], dict):
            merged_section["mcpServers"] = dict(patch["mcpServers"])
        if "mcp_servers" in patch and isinstance(patch["mcp_servers"], dict):
            merged_section["mcp_servers"] = dict(patch["mcp_servers"])
    merged = dict(raw)
    merged[section] = merged_section
    return merged


def save_full_config(path: Path, merged: dict[str, Any]) -> None:
    """Validate core sections; write JSON including extras (e.g. ``skills``)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    core_dict = {k: merged[k] for k in CONFIG_ROOT_KEYS if k in merged}
    cfg = Config.model_validate(core_dict)
    dump = cfg.model_dump(mode="json", by_alias=True)
    extras = {k: v for k, v in merged.items() if k not in CONFIG_ROOT_KEYS}
    full = {**dump, **extras}
    with path.open("w", encoding="utf-8") as f:
        json.dump(full, f, indent=2, ensure_ascii=False)


def _default_core_config() -> dict[str, Any]:
    """Return a fresh dump of OpenPawlet ``Config`` defaults (camelCase aliases)."""
    return Config().model_dump(mode="json", by_alias=True)


def ensure_full_config(path: Path) -> bool:
    """Auto-fill any OpenPawlet core fields missing from the on-disk config.

    Reads the user's ``config.json``, deep-merges it on top of the current
    :class:`Config` defaults, and writes the result back **only when the
    file content would actually change**. This keeps user-provided values
    intact (including unknown extras like ``skills``) while making sure new
    schema fields introduced by upstream OpenPawlet upgrades show up in the
    file on the next run instead of silently inheriting defaults.

    The file is not auto-created when missing — that aligns with the
    broader "config is opt-in" policy and avoids touching ``~/.openpawlet/``
    during test runs that never asked for a config file.

    Returns ``True`` when the file was rewritten, ``False`` otherwise.

    Failures are non-fatal: if validation fails (e.g. user wrote an invalid
    value) we log and leave the file untouched so the surrounding startup
    code can still surface the original error.
    """
    if not path.exists():
        return False

    try:
        defaults = _default_core_config()
        raw = load_raw_config(path)

        # Build merged: defaults first, then user values override + extras kept.
        merged_core: dict[str, Any] = {}
        for key in CONFIG_ROOT_KEYS:
            base = defaults.get(key, {})
            user = raw.get(key)
            if isinstance(base, dict) and isinstance(user, dict):
                merged_core[key] = deep_merge(base, user)
            elif user is not None:
                merged_core[key] = user
            else:
                merged_core[key] = base

        try:
            cfg = Config.model_validate(merged_core)
        except ValidationError as exc:
            logger.warning(
                "[config] Skip auto-fill for {} due to validation error: {}",
                path,
                exc,
            )
            return False
        normalized_core = cfg.model_dump(mode="json", by_alias=True)

        extras = {k: v for k, v in raw.items() if k not in CONFIG_ROOT_KEYS}
        full = {**normalized_core, **extras}

        # Compare against the current on-disk JSON (raw bytes -> dict) so we
        # only write when there's a real difference. ``load_raw_config`` runs
        # ``migrate_config`` which itself may rewrite legacy keys; we treat
        # that migration as a desired auto-fix and write it back here.
        existing_raw: dict[str, Any] = {}
        try:
            with path.open(encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                existing_raw = loaded
        except (OSError, json.JSONDecodeError):
            existing_raw = {}

        if existing_raw == full:
            return False

        with path.open("w", encoding="utf-8") as f:
            json.dump(full, f, indent=2, ensure_ascii=False)
        logger.info("[config] Auto-filled missing fields in {}", path)
        return True
    except OSError as exc:
        logger.warning("[config] ensure_full_config({}) failed: {}", path, exc)
        return False


def _build_config_response_uncached(path: Path) -> dict[str, Any]:
    """Slow-path implementation; ``build_config_response`` adds an mtime cache."""
    if not path.exists():
        return Config().model_dump(mode="json", by_alias=True)
    raw = load_raw_config(path)
    if not raw:
        return Config().model_dump(mode="json", by_alias=True)
    core_dict = {k: raw[k] for k in CONFIG_ROOT_KEYS if k in raw}
    try:
        cfg = Config.model_validate(core_dict)
    except ValidationError as exc:
        logger.error("[config] Invalid config in {}: {}", path, exc)
        raise
    base = cfg.model_dump(mode="json", by_alias=True)
    extras = {k: v for k, v in raw.items() if k not in CONFIG_ROOT_KEYS}
    return {**base, **extras}


def build_config_response(path: Path) -> dict[str, Any]:
    """Build the GET ``/config`` payload: validated core + extra top-level keys.

    Cached by ``(path, mtime_ns)`` because the same config is read many
    times per status / dashboard request and pydantic validation is the
    dominant cost.
    """
    from console.server.cache import config_cache

    return config_cache().get_or_load(path, _build_config_response_uncached)


def validate_core_config(merged: dict[str, Any]) -> tuple[bool, list[str]]:
    """Validate OpenPawlet core keys in ``merged``; return ``(valid, error strings)``."""
    core_dict = {k: merged[k] for k in CONFIG_ROOT_KEYS if k in merged}
    try:
        Config.model_validate(core_dict)
    except ValidationError as exc:
        errors = [f"{e['loc']}: {e['msg']}" for e in exc.errors()]
        return False, errors
    return True, []


def env_file_path(bot_id: str | None) -> Path:
    """Return ``.env`` path next to ``config.json``."""
    return resolve_config_path(bot_id).parent / ".env"


# Re-export ``.env`` IO helpers so existing callers don't need to update.
from console.server.dotenv_io import parse_dotenv_file, write_dotenv_file  # noqa: E402, F401


def _read_agents_defaults(path: Path) -> dict[str, Any] | None:
    """Return the ``agents.defaults`` mapping from config at ``path``, or ``None``."""
    try:
        data = build_config_response(path)
    except (ValidationError, OSError):
        return None
    agents = data.get("agents")
    if not isinstance(agents, dict):
        return None
    defaults = agents.get("defaults")
    return defaults if isinstance(defaults, dict) else None


def read_default_model(path: Path) -> str | None:
    """Return ``agents.defaults.model`` from config at ``path``, if present."""
    defaults = _read_agents_defaults(path)
    if defaults is None:
        return None
    model = defaults.get("model")
    return model if isinstance(model, str) else None


def read_default_timezone(path: Path) -> str | None:
    """Return ``agents.defaults.timezone`` (IANA) from config at ``path``, if present."""
    defaults = _read_agents_defaults(path)
    if defaults is None:
        return None
    tz = defaults.get("timezone")
    return tz.strip() if isinstance(tz, str) and tz.strip() else None
