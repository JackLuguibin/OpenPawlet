"""JSON config file loader for the OpenPawlet console server.

The optional ``nanobot_web.json`` lives next to the nanobot config
(``~/.nanobot/`` by default, see :func:`nanobot.config.get_config_path`). Its
top-level ``server`` key mirrors the ``NANOBOT_SERVER_*`` environment
variables; any field not present falls back to env / defaults (see
:class:`ServerSettings` for the full resolution order).

``get_settings()`` caches a single :class:`ServerSettings` instance per
process. Reading config is **read-only**: we no longer auto-write a defaults
file on first boot. Use :func:`write_default_config` (or the ``console
init-config`` CLI command) to materialize the JSON file explicitly.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from loguru import logger

from console.server.config.schema import ServerSettings

CONFIG_FILENAME = "nanobot_web.json"
_SERVER_KEY = "server"


def find_config_file() -> Path:
    """Return the path to ``nanobot_web.json`` next to the nanobot config file."""
    from nanobot.config import get_config_path

    return get_config_path().parent / CONFIG_FILENAME


def load_config_file(config_path: Path | None = None) -> dict[str, Any]:
    """Return the ``server`` section from ``nanobot_web.json``, or empty dict.

    Uses ``find_config_file()`` when ``config_path`` is omitted. Malformed
    files are logged and treated as empty so a bad file never prevents the
    server from starting with env + defaults.
    """
    path = config_path if config_path is not None else find_config_file()
    if not path.exists():
        return {}
    try:
        with path.open(encoding="utf-8") as f:
            data: Any = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning(
            "[config] Could not read {}: {}. Falling back to env + defaults.",
            path,
            exc,
        )
        return {}
    if not isinstance(data, dict):
        logger.warning(
            "[config] Top-level JSON value in {} must be an object; ignoring file",
            path,
        )
        return {}
    raw_server = data.get(_SERVER_KEY, {})
    if not isinstance(raw_server, dict):
        logger.warning(
            "[config] Key {!r} in {} must be an object; using defaults",
            _SERVER_KEY,
            path,
        )
        return {}
    return raw_server


def write_default_config(config_path: Path | None = None) -> Path:
    """Write a default ``nanobot_web.json`` and return its path.

    The file always reflects the **schema defaults** regardless of the
    surrounding environment — i.e. env vars or a pre-existing JSON file do
    not leak into the newly written file. This matches the user intent of
    "give me a clean starter file" for the ``console init-config`` command.

    ``get_settings`` never calls this function so reading configuration
    remains side-effect free.
    """
    path = config_path if config_path is not None else find_config_file()

    # Build the default snapshot from field metadata so it is independent of
    # any current env / .env / existing-file state.  Fields that use a
    # ``default_factory`` (e.g. ``version`` resolved from package metadata)
    # report ``PydanticUndefined`` for ``field.default``; call the factory so
    # the resulting JSON is always serialisable.
    defaults: dict[str, Any] = {}
    for name, field in ServerSettings.model_fields.items():
        if field.default_factory is not None:
            defaults[name] = field.default_factory()
        else:
            defaults[name] = field.default
    default_config = {_SERVER_KEY: defaults}

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(default_config, f, indent=4, ensure_ascii=False)

    return path


@lru_cache(maxsize=1)
def get_settings() -> ServerSettings:
    """Return a cached :class:`ServerSettings` singleton.

    Settings are resolved via pydantic-settings using the source priority
    declared on :class:`ServerSettings`. Call :func:`reset_settings_cache`
    from tests or long-running tools that need to reload settings after
    mutating env vars or the JSON file.
    """
    settings = ServerSettings()
    logger.debug(
        "[config] Settings resolved: host={} port={} reload={} docs={} openapi={}",
        settings.host,
        settings.port,
        settings.reload,
        settings.effective_docs_url,
        settings.effective_openapi_url,
    )
    return settings


def reset_settings_cache() -> None:
    """Clear the :func:`get_settings` cache so the next call re-resolves."""
    get_settings.cache_clear()
