"""In-process ring buffer and optional local JSONL append for agent observability events."""

from __future__ import annotations

import json
import os
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

from loguru import logger

from nanobot.config.paths import get_data_dir
from nanobot.utils.helpers import ensure_dir

_MAX_DEFAULT = 500
_ERR_LOG_INTERVAL_S = 60.0
_buffer: deque[dict[str, Any]] = deque(maxlen=_MAX_DEFAULT)
_lock = threading.Lock()
_jsonl_lock = threading.Lock()
_last_jsonl_error_log: float = 0.0


def is_buffer_enabled() -> bool:
    v = (os.environ.get("NANOBOT_OBS_BUFFER") or "1").strip().lower()
    return v not in ("0", "false", "no", "off")


def is_jsonl_enabled() -> bool:
    """When True, each recorded event is also appended to a JSONL file (see env NANOBOT_OBS_JSONL)."""
    v = (os.environ.get("NANOBOT_OBS_JSONL") or "").strip()
    if not v:
        return False
    if v.lower() in ("0", "false", "no", "off"):
        return False
    return True


def _jsonl_uses_data_dir_daily_file() -> bool:
    v = (os.environ.get("NANOBOT_OBS_JSONL") or "").strip().lower()
    return v in ("1", "true", "yes")


def _jsonl_output_path() -> Path:
    if _jsonl_uses_data_dir_daily_file():
        day = time.strftime("%Y-%m-%d", time.localtime())
        return get_data_dir() / "observability" / f"events_{day}.jsonl"
    raw = (os.environ.get("NANOBOT_OBS_JSONL") or "").strip()
    return Path(raw).expanduser().resolve()


def _log_jsonl_error(exc: OSError) -> None:
    global _last_jsonl_error_log
    now = time.time()
    if now - _last_jsonl_error_log < _ERR_LOG_INTERVAL_S:
        return
    _last_jsonl_error_log = now
    logger.warning("observability jsonl append failed: {}", exc)


def _append_jsonl_line(row: dict[str, Any]) -> None:
    with _jsonl_lock:
        try:
            path = _jsonl_output_path()
            ensure_dir(path.parent)
            line = json.dumps(row, ensure_ascii=False) + "\n"
            with open(path, "a", encoding="utf-8") as f:
                f.write(line)
        except OSError as e:
            _log_jsonl_error(e)


def record_event(
    event: str,
    *,
    trace_id: str | None = None,
    session_key: str | None = None,
    payload: dict[str, Any] | None = None,
) -> None:
    if not is_buffer_enabled() and not is_jsonl_enabled():
        return
    row: dict[str, Any] = {
        "ts": time.time(),
        "event": event,
        "trace_id": trace_id,
        "session_key": session_key,
        "payload": dict(payload) if payload else {},
    }
    if is_buffer_enabled():
        with _lock:
            _buffer.append(row)
    if is_jsonl_enabled():
        _append_jsonl_line(row)


def get_recent(
    *,
    limit: int = 200,
    trace_id: str | None = None,
) -> list[dict[str, Any]]:
    """Newest first. ``limit`` caps the returned list after optional ``trace_id`` filter."""
    lim = max(1, min(2000, int(limit)))
    with _lock:
        items = list(_buffer)
    if trace_id:
        items = [e for e in items if (e.get("trace_id") or "") == trace_id]
    # deque order: oldest to newest in list(items) if we only append — last is newest
    items = list(reversed(items))
    return items[:lim]


def to_http_json(
    *,
    limit: int = 200,
    trace_id: str | None = None,
) -> dict[str, Any]:
    return {
        "ok": True,
        "events": get_recent(limit=limit, trace_id=trace_id),
    }
