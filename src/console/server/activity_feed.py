"""Map nanobot observability buffer rows to console ActivityItem for the activity feed."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Any

from console.server.models import ActivityItem


def _error_like_text(s: str | None) -> bool:
    if not s:
        return False
    n = s.lower()
    return "error" in n or "fail" in n or "exception" in n


def _payload_dict(row: dict[str, Any]) -> dict[str, Any]:
    p = row.get("payload")
    if isinstance(p, dict):
        return p
    return {}


def _activity_row_id(row: dict[str, Any]) -> str:
    ts = row.get("ts", "")
    event = row.get("event", "")
    trace = row.get("trace_id") or ""
    sess = row.get("session_key") or ""
    payload = _payload_dict(row)
    try:
        p = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    except (TypeError, ValueError):
        p = str(payload)
    raw = f"{ts}\x1f{event}\x1f{trace}\x1f{sess}\x1f{p}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:40]


def _iso_timestamp(ts: Any) -> str:
    if isinstance(ts, (int, float)):
        sec = float(ts)
    else:
        try:
            sec = float(ts)
        except (TypeError, ValueError):
            sec = 0.0
    return datetime.fromtimestamp(sec, tz=UTC).isoformat()


def _map_row_to_item(row: dict[str, Any]) -> ActivityItem | None:
    event = row.get("event")
    if not isinstance(event, str):
        return None
    e = event.strip().lower()
    tid = row.get("trace_id")
    trace_s = str(tid) if tid is not None else None
    session_key = row.get("session_key")
    session_s = str(session_key) if session_key is not None else None
    payload = _payload_dict(row)
    ts_raw = row.get("ts", 0)
    timestamp = _iso_timestamp(ts_raw)
    base_meta: dict[str, Any] = {
        "source_event": event,
        "payload": payload,
    }
    if trace_s:
        base_meta["trace_id"] = trace_s
    if session_s:
        base_meta["session_key"] = session_s

    if e == "llm":
        kind = payload.get("kind", "")
        model = payload.get("model", "")
        iteration = payload.get("iteration", "")
        wall_ms = payload.get("wall_ms", "")
        title = f"LLM {kind}".strip() if kind else "LLM"
        if model:
            title = f"{title} ({model})"
        parts: list[str] = []
        if iteration != "":
            parts.append(f"iteration={iteration}")
        if wall_ms != "":
            parts.append(f"wall_ms={wall_ms}")
        description = ", ".join(parts) if parts else None
        return ActivityItem(
            id=_activity_row_id(row),
            type="message",
            title=title,
            description=description,
            timestamp=timestamp,
            metadata=base_meta,
        )

    if e == "tool":
        name = str(payload.get("name", "tool"))
        status = payload.get("status")
        status_s = str(status) if status is not None else ""
        detail = payload.get("detail")
        detail_s = str(detail) if detail is not None else None
        duration_ms = payload.get("duration_ms", "")
        is_err = _error_like_text(status_s) or _error_like_text(detail_s)
        activity_type = "error" if is_err else "tool_call"
        title = f"{name} ({status_s})" if status_s else name
        desc_parts: list[str] = []
        if duration_ms != "":
            desc_parts.append(f"duration_ms={duration_ms}")
        if detail_s:
            desc_parts.append(detail_s)
        description = ", ".join(desc_parts) if desc_parts else None
        return ActivityItem(
            id=_activity_row_id(row),
            type=activity_type,
            title=title,
            description=description,
            timestamp=timestamp,
            metadata=base_meta,
        )

    if e == "run_start":
        desc = f"session_key={session_s}" if session_s else None
        return ActivityItem(
            id=_activity_row_id(row),
            type="session",
            title="Run started",
            description=desc,
            timestamp=timestamp,
            metadata=base_meta,
        )

    if e == "run_end":
        dur = payload.get("duration_ms")
        desc_parts: list[str] = []
        if session_s:
            desc_parts.append(f"session_key={session_s}")
        if dur is not None and dur != "":
            desc_parts.append(f"duration_ms={dur}")
        description = ", ".join(desc_parts) if desc_parts else None
        return ActivityItem(
            id=_activity_row_id(row),
            type="session",
            title="Run completed",
            description=description,
            timestamp=timestamp,
            metadata=base_meta,
        )

    if _error_like_text(e):
        return ActivityItem(
            id=_activity_row_id(row),
            type="error",
            title=event,
            description=json.dumps(payload, ensure_ascii=False)[:500] if payload else None,
            timestamp=timestamp,
            metadata=base_meta,
        )

    return None


def observability_rows_to_activity_items(
    rows: list[dict[str, Any]],
    *,
    activity_type_filter: str | None = None,
) -> list[ActivityItem]:
    """Convert raw observability API event dicts to activity feed items (newest-first preserved)."""
    filt = (activity_type_filter or "").strip().lower()
    out: list[ActivityItem] = []
    for row in rows:
        item = _map_row_to_item(row)
        if item is None:
            continue
        if filt and filt not in ("all", "*"):
            if item.type != filt:
                continue
        out.append(item)
    return out
