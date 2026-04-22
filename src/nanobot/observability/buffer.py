"""In-process ring buffer of agent observability events (for API / UI, not durable)."""

from __future__ import annotations

import os
import threading
import time
from collections import deque
from typing import Any

_MAX_DEFAULT = 500
_buffer: deque[dict[str, Any]] = deque(maxlen=_MAX_DEFAULT)
_lock = threading.Lock()


def is_buffer_enabled() -> bool:
    v = (os.environ.get("NANOBOT_OBS_BUFFER") or "1").strip().lower()
    return v not in ("0", "false", "no", "off")


def record_event(
    event: str,
    *,
    trace_id: str | None = None,
    session_key: str | None = None,
    payload: dict[str, Any] | None = None,
) -> None:
    if not is_buffer_enabled():
        return
    row: dict[str, Any] = {
        "ts": time.time(),
        "event": event,
        "trace_id": trace_id,
        "session_key": session_key,
        "payload": dict(payload) if payload else {},
    }
    with _lock:
        _buffer.append(row)


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
