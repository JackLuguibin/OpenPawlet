"""JSON config file loader for nanobot-web.

Places ``nanobot_web.json`` beside the nanobot config directory (see
``nanobot.config.get_config_path``). The file format is JSON with a top-level
``server`` key that mirrors the ``NANOBOT_SERVER_*`` environment variables.
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

    Uses ``find_config_file()`` when ``config_path`` is omitted.
    """
    path = config_path if config_path is not None else find_config_file()
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as f:
        data: Any = json.load(f)
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
    """Write default ``nanobot_web.json`` beside nanobot config; return its path.

    Uses ``find_config_file()`` when ``config_path`` is omitted.
    """
    path = config_path if config_path is not None else find_config_file()
    default_config = {_SERVER_KEY: ServerSettings().model_dump()}

    with path.open("w", encoding="utf-8") as f:
        json.dump(default_config, f, indent=4, ensure_ascii=False)

    return path


@lru_cache(maxsize=1)
def get_settings() -> ServerSettings:
    """Return cached settings singleton."""
    path = find_config_file()
    if not path.exists():
        written = write_default_config(path)
        logger.warning(
            "[config] No config file found — wrote defaults to {}",
            written,
        )

    json_config = load_config_file(path)
    return ServerSettings(**json_config)
