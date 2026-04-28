"""Read tail of local runtime log files (console server)."""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from pathlib import Path

from openpawlet.config.paths import get_logs_dir

_LOG_NAMES = {"console": "console.log"}


@dataclass(frozen=True)
class RuntimeLogCursor:
    """Pagination cursor for runtime log history."""

    snapshot_end: int
    before_lines: int


@dataclass(frozen=True)
class RuntimeLogPage:
    """One paginated slice of a runtime log file."""

    text: str
    has_more: bool
    next_cursor: str | None
    truncated: bool


def default_runtime_log_path(source: str) -> Path:
    """Return absolute path to the log file for ``source`` (currently ``console``)."""
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


def encode_runtime_log_cursor(cursor: RuntimeLogCursor) -> str:
    """Encode cursor into a compact URL-safe token."""
    payload = {"v": 1, "snapshot_end": cursor.snapshot_end, "before_lines": cursor.before_lines}
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_runtime_log_cursor(token: str) -> RuntimeLogCursor:
    """Decode a runtime log cursor token."""
    padded = token + "=" * (-len(token) % 4)
    try:
        raw = base64.urlsafe_b64decode(padded.encode("ascii"))
        payload = json.loads(raw.decode("utf-8"))
        if payload.get("v") != 1:
            raise ValueError("unsupported runtime log cursor version")
        snapshot_end = int(payload.get("snapshot_end"))
        before_lines = int(payload.get("before_lines"))
    except Exception as exc:  # noqa: BLE001 - normalize as ValueError for router
        raise ValueError("invalid runtime log cursor") from exc
    if snapshot_end < 0 or before_lines < 0:
        raise ValueError("invalid runtime log cursor")
    return RuntimeLogCursor(snapshot_end=snapshot_end, before_lines=before_lines)


def read_log_page(
    path: Path,
    *,
    limit: int,
    cursor_token: str | None = None,
    max_snapshot_read_bytes: int = 4_000_000,
) -> RuntimeLogPage:
    """Read a stable paginated log page using snapshot-bound cursors.

    ``cursor_token`` pins reads to one file snapshot (``snapshot_end``), so later
    appends do not leak into older-page fetches.
    """
    if limit < 1:
        raise ValueError("limit must be >= 1")
    if not path.is_file():
        return RuntimeLogPage(text="", has_more=False, next_cursor=None, truncated=False)

    size = path.stat().st_size
    if size == 0:
        return RuntimeLogPage(text="", has_more=False, next_cursor=None, truncated=False)

    if cursor_token:
        cursor = decode_runtime_log_cursor(cursor_token)
        snapshot_end = min(cursor.snapshot_end, size)
        before_lines = cursor.before_lines
    else:
        snapshot_end = size
        before_lines = 0

    start = max(0, snapshot_end - max_snapshot_read_bytes)
    window_truncated = start > 0
    with path.open("rb") as f:
        if start:
            f.seek(start)
        raw = f.read(snapshot_end - start)

    text = raw.decode("utf-8", errors="replace")
    if text.startswith("\ufeff"):
        text = text[1:]
    lines = text.splitlines()
    total = len(lines)
    if total == 0:
        return RuntimeLogPage(text="", has_more=False, next_cursor=None, truncated=False)

    before = min(before_lines, total)
    end_idx = total - before
    start_idx = max(0, end_idx - limit)
    page_lines = lines[start_idx:end_idx]

    next_before = total - start_idx
    has_more = start_idx > 0 or window_truncated
    next_cursor = (
        encode_runtime_log_cursor(RuntimeLogCursor(snapshot_end=snapshot_end, before_lines=next_before))
        if has_more
        else None
    )

    if not page_lines:
        return RuntimeLogPage(text="", has_more=False, next_cursor=None, truncated=False)
    body = "\n".join(page_lines)
    return RuntimeLogPage(
        text=body if body.endswith("\n") else f"{body}\n",
        has_more=has_more,
        next_cursor=next_cursor,
        truncated=has_more,
    )
