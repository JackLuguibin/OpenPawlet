"""Read tail of local runtime log files (nanobot gateway + console server)."""

from __future__ import annotations

from pathlib import Path

from nanobot.config.paths import get_logs_dir

_LOG_NAMES = {
    "nanobot": "nanobot.log",
    "console": "console.log",
}


def default_runtime_log_path(source: str) -> Path:
    """Return absolute path to the log file for ``source`` (``nanobot`` or ``console``)."""
    if source not in _LOG_NAMES:
        raise ValueError(f"unknown log source: {source}")
    return get_logs_dir() / _LOG_NAMES[source]


def read_tail_text(
    path: Path,
    *,
    max_lines: int,
    max_read_bytes: int = 900_000,
) -> tuple[str, bool]:
    """Read up to the last ``max_lines`` lines from a UTF-8 file.

    Returns:
        ``(text, truncated)`` where ``truncated`` is True when the file was
        larger than ``max_read_bytes`` or had more than ``max_lines`` lines
        in the read window.
    """
    if not path.is_file():
        return "", False
    size = path.stat().st_size
    if size == 0:
        return "", False
    truncated = False
    with path.open("rb") as f:
        if size <= max_read_bytes:
            raw = f.read()
        else:
            f.seek(size - max_read_bytes)
            raw = f.read()
            truncated = True
    text = raw.decode("utf-8", errors="replace")
    if text.startswith("\ufeff"):
        text = text[1:]
    lines = text.splitlines()
    if len(lines) > max_lines:
        lines = lines[-max_lines:]
        truncated = True
    if not lines:
        return "", truncated
    body = "\n".join(lines)
    return body if body.endswith("\n") else f"{body}\n", truncated
