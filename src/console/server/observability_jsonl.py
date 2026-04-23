"""Read agent observability events from nanobot JSONL files (no gateway request)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from nanobot.utils.helpers import ensure_dir


def data_dir_for_config(config_path: Path) -> Path:
    """Match nanobot ``get_data_dir()`` for a given config file (parent directory)."""
    return ensure_dir(config_path.resolve().parent)


def _sorted_newest_event_files(obs_dir: Path) -> list[Path]:
    if not obs_dir.is_dir():
        return []
    # Lexicographic reverse works for events_YYYY-MM-DD.jsonl
    return sorted(obs_dir.glob("events_*.jsonl"), key=lambda p: p.name, reverse=True)


def read_recent_observability_dicts(
    data_dir: Path,
    *,
    limit: int,
    trace_id: str | None = None,
) -> tuple[list[dict[str, Any]], str, str | None]:
    """Load newest events from JSONL under ``data_dir/observability/``.

    Same row shape as nanobot ``buffer.record_event`` (``ts``, ``event``, ``trace_id``, ...).

    Returns ``(rows, source_label, error)`` when the directory is missing, there are no
    files yet, or read fails. Nanobot always appends to these files when events are recorded.
    """
    lim = max(1, min(2000, int(limit)))
    obs_dir = data_dir / "observability"
    label = f"jsonl:{obs_dir}"
    if not obs_dir.is_dir():
        return (
            [],
            label,
            "No observability/ directory under the bot data path (nanobot has not created it yet).",
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
