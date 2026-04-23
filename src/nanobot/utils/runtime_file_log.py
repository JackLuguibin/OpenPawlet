"""Optional loguru file sink for long-running daemons (gateway, etc.)."""

from __future__ import annotations

from pathlib import Path

from loguru import logger

from nanobot.config.paths import get_logs_dir

_installed: set[str] = set()


def install_runtime_file_log(
    name: str,
    *,
    level: str = "DEBUG",
) -> Path:
    """Append a rotating log file under the instance ``logs/`` directory.

    Safe to call once per process per ``name``; repeated calls for the same
    ``name`` are no-ops and return the existing path.

    Args:
        name: Base file name without extension (e.g. ``"nanobot"`` -> ``nanobot.log``).
        level: Min level for the file sink (loguru level name).

    Returns:
        Absolute path to the log file.
    """
    if name in _installed:
        return get_logs_dir() / f"{name}.log"
    out = get_logs_dir() / f"{name}.log"
    logger.add(
        str(out),
        rotation="10 MB",
        retention=8,
        compression="zip",
        level=level,
        encoding="utf-8",
        enqueue=True,
    )
    _installed.add(name)
    return out
