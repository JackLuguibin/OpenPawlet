"""Read/write nanobot chat sessions under ``<workspace>/sessions/*.jsonl``."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from nanobot.config.paths import get_legacy_sessions_dir
from nanobot.session.manager import Session, SessionManager
from nanobot.utils.helpers import safe_filename

from console.server.bot_workspace import workspace_root

_VALID_TRANSCRIPT_ROLES = frozenset({"user", "assistant", "system", "tool"})


def _transcript_file_path(ws: Path, session_key: str) -> Path:
    """Path to ``<workspace>/transcripts/{safe_key}.jsonl`` (matches ``SessionTranscriptWriter``)."""
    safe_key = safe_filename(session_key.replace(":", "_"))
    return ws / "transcripts" / f"{safe_key}.jsonl"


def parse_transcript_jsonl(path: Path) -> list[dict[str, Any]]:
    """Read append-only transcript JSONL and return chat message dicts in file order.

    Skips compaction / eviction records (``_event``) and non-message rows so the result
    is a linear history suitable for UI replay without duplicating evicted lines.
    """
    out: list[dict[str, Any]] = []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(data, dict):
            continue
        if data.get("_event"):
            continue
        if data.get("_type") == "metadata":
            continue
        role = data.get("role")
        if role not in _VALID_TRANSCRIPT_ROLES:
            continue
        out.append(data)
    return out


def load_transcript_messages(bot_id: str | None, session_key: str) -> list[dict[str, Any]] | None:
    """Load messages from ``workspace/transcripts/{key}.jsonl``.

    Returns ``None`` if the transcript file is absent (caller may fall back to session JSONL).
    Returns an empty list if the file exists but yields no message lines.
    """
    root = workspace_root(bot_id)
    path = _transcript_file_path(root, session_key)
    if not path.is_file():
        return None
    return parse_transcript_jsonl(path)


def _primary_and_legacy_paths(mgr: SessionManager, key: str) -> tuple[Path, Path]:
    safe_key = safe_filename(key.replace(":", "_"))
    primary = mgr.sessions_dir / f"{safe_key}.jsonl"
    legacy = get_legacy_sessions_dir() / f"{safe_key}.jsonl"
    return primary, legacy


def _count_jsonl_messages(path: Path) -> int:
    """Count chat message lines (exclude leading metadata row if present)."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return 0
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines:
        return 0
    try:
        first = json.loads(lines[0])
    except json.JSONDecodeError:
        return len(lines)
    if isinstance(first, dict) and first.get("_type") == "metadata":
        return max(0, len(lines) - 1)
    return len(lines)


def list_session_rows(bot_id: str | None) -> list[dict[str, Any]]:
    """Return session list entries with keys, timestamps, and message counts."""
    mgr = SessionManager(workspace_root(bot_id))
    rows = mgr.list_sessions()
    out: list[dict[str, Any]] = []
    for row in rows:
        path = Path(row["path"])
        out.append(
            {
                "key": row["key"],
                "created_at": row.get("created_at"),
                "updated_at": row.get("updated_at"),
                "message_count": _count_jsonl_messages(path),
            }
        )
    return out


def load_session(bot_id: str | None, session_key: str) -> Session | None:
    """Load a session from disk, or ``None`` if it does not exist."""
    mgr = SessionManager(workspace_root(bot_id))
    return mgr._load(session_key)


def save_empty_session(bot_id: str | None, session_key: str) -> Session:
    """Create a new empty session file if missing (POST /sessions)."""
    mgr = SessionManager(workspace_root(bot_id))
    existing = mgr._load(session_key)
    if existing is not None:
        return existing
    session = Session(key=session_key)
    mgr.save(session)
    return session


def delete_session_files(bot_id: str | None, session_key: str) -> bool:
    """Delete session JSONL from workspace and legacy global dir.

    Returns True if at least one file was removed.
    """
    mgr = SessionManager(workspace_root(bot_id))
    primary, legacy = _primary_and_legacy_paths(mgr, session_key)
    removed = False
    for path in (primary, legacy):
        if path.is_file():
            path.unlink()
            removed = True
    mgr.invalidate(session_key)
    return removed
