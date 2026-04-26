"""User-facing ``config.json`` load/save for the console API."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from loguru import logger
from pydantic import ValidationError

from nanobot.config.loader import migrate_config
from nanobot.config.schema import Config

CONFIG_ROOT_KEYS = frozenset({"agents", "channels", "providers", "api", "gateway", "tools"})

# Shared OpenAPI description for the optional ``bot_id`` query parameter.
# The console is currently single-instance (one ``~/.nanobot/config.json``);
# ``bot_id`` is kept as a parameter on every bot-scoped route so the REST
# surface is stable once per-bot storage lands, but it is **ignored today**.
BOT_ID_DESCRIPTION = (
    "Reserved for future multi-instance support. Currently ignored; the "
    "console always operates against the single nanobot config under "
    "``~/.nanobot/config.json``."
)


def resolve_config_path(bot_id: str | None) -> Path:
    """Return ``config.json`` path for the given bot.

    Resolves through :func:`console.server.bots_registry.get_registry` so
    callers transparently get the right per-bot file when multi-instance
    is in use.  Falls back to the legacy ``~/.nanobot/config.json`` when
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
    """Load JSON from ``path`` and apply nanobot migrations."""
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
    """Return a fresh dump of nanobot ``Config`` defaults (camelCase aliases)."""
    return Config().model_dump(mode="json", by_alias=True)


def ensure_full_config(path: Path) -> bool:
    """Auto-fill any nanobot core fields missing from the on-disk config.

    Reads the user's ``config.json``, deep-merges it on top of the current
    :class:`Config` defaults, and writes the result back **only when the
    file content would actually change**. This keeps user-provided values
    intact (including unknown extras like ``skills``) while making sure new
    schema fields introduced by upstream nanobot upgrades show up in the
    file on the next run instead of silently inheriting defaults.

    The file is not auto-created when missing — that aligns with the
    broader "config is opt-in" policy and avoids touching ``~/.nanobot/``
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
    """Validate nanobot core keys in ``merged``; return ``(valid, error strings)``."""
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


def parse_dotenv_file(path: Path) -> dict[str, str]:
    """Parse a minimal KEY=VALUE ``.env`` file into a string dict."""
    if not path.exists():
        return {}
    result: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        key = key.strip()
        if not key:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] in "\"'":
            quote = value[0]
            if value.endswith(quote):
                value = value[1:-1]
        result[key] = value
    return result


def write_dotenv_file(path: Path, vars_map: dict[str, str]) -> None:
    """Write ``vars_map`` to ``path`` as sorted KEY=VALUE lines."""
    path.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    for key in sorted(vars_map.keys()):
        val = vars_map[key]
        if _dotenv_value_needs_quoting(val):
            val_out = json.dumps(val, ensure_ascii=False)
        else:
            val_out = val
        lines.append(f"{key}={val_out}")
    path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def _dotenv_value_needs_quoting(value: str) -> bool:
    """Return True if ``value`` should be JSON-quoted for ``.env``."""
    if not value:
        return False
    if any(c in value for c in "\n\r#\"'"):
        return True
    if value.startswith(" ") or value.endswith(" "):
        return True
    return False


def read_default_model(path: Path) -> str | None:
    """Return ``agents.defaults.model`` from config at ``path``, if present."""
    try:
        data = build_config_response(path)
    except ValidationError:
        return None
    except OSError:
        return None
    agents = data.get("agents")
    if not isinstance(agents, dict):
        return None
    defaults = agents.get("defaults")
    if not isinstance(defaults, dict):
        return None
    model = defaults.get("model")
    return model if isinstance(model, str) else None


def read_default_timezone(path: Path) -> str | None:
    """Return ``agents.defaults.timezone`` (IANA) from config at ``path``, if present."""
    try:
        data = build_config_response(path)
    except ValidationError:
        return None
    except OSError:
        return None
    agents = data.get("agents")
    if not isinstance(agents, dict):
        return None
    defaults = agents.get("defaults")
    if not isinstance(defaults, dict):
        return None
    tz = defaults.get("timezone")
    return tz.strip() if isinstance(tz, str) and tz.strip() else None
