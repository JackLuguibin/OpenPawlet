"""In-process ring buffer and always-on local JSONL append for agent observability events."""

from __future__ import annotations

import json
import os
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

from loguru import logger

from nanobot.config.paths import observability_jsonl_path_for_session
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


def _jsonl_output_path(session_key: str | None) -> Path:
    return observability_jsonl_path_for_session(session_key)


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
            sk = row.get("session_key")
            sk_s = sk.strip() if isinstance(sk, str) else None
            path = _jsonl_output_path(sk_s)
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
    _append_jsonl_line(row)
