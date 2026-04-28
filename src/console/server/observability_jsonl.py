"""Read agent observability events from OpenPawlet JSONL files (no gateway request)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def _sorted_newest_event_files(obs_dir: Path) -> list[Path]:
    """Collect ``events_*.jsonl`` under ``obs_dir`` and per-session ``obs_dir/sessions/*/``."""
    if not obs_dir.is_dir():
        return []
    files: list[Path] = []
    files.extend(obs_dir.glob("events_*.jsonl"))
    sessions = obs_dir / "sessions"
    if sessions.is_dir():
        for sub in sessions.iterdir():
            if sub.is_dir():
                files.extend(sub.glob("events_*.jsonl"))
    # Lexicographic reverse works for events_YYYY-MM-DD.jsonl; tie-break by path for same day.
    return sorted(files, key=lambda p: (p.name, str(p)), reverse=True)


def read_recent_observability_dicts(
    workspace_root: Path,
    *,
    limit: int,
    trace_id: str | None = None,
) -> tuple[list[dict[str, Any]], str, str | None]:
    """Load newest events from JSONL under ``<workspace_root>/observability/``.

    Session runs append to ``observability/sessions/{safe_session_key}/events_*.jsonl``;
    events without a session use ``observability/events_*.jsonl``.

    Same row shape as OpenPawlet ``buffer.record_event`` (``ts``, ``event``, ``trace_id``, ...).

    Returns ``(rows, source_label, error)`` when the directory is missing, there are no
    files yet, or read fails.
    """
    lim = max(1, min(2000, int(limit)))
    obs_dir = workspace_root / "observability"
    label = f"jsonl:{obs_dir}"
    if not obs_dir.is_dir():
        return (
            [],
            label,
            "No observability/ directory under the workspace (OpenPawlet has not created it yet).",
        )
    files = _sorted_newest_event_files(obs_dir)
    if not files:
        return (
            [],
            label,
            "No events_*.jsonl under observability/ yet. Use the bot to generate events, then refresh.",
        )

    tid = (trace_id or "").strip() or None
    out: list[dict[str, Any]] = []
    for path in files:
        if len(out) >= lim:
            break
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as e:
            return [], label, str(e) or "read error"
        lines = [ln for ln in text.splitlines() if ln.strip()]
        for line in reversed(lines):
            if len(out) >= lim:
                break
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(row, dict):
                continue
            if tid and (row.get("trace_id") or "") != tid:
                continue
            out.append(row)
    return out, label, None
