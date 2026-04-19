"""Read/write nanobot chat sessions under ``<workspace>/sessions/*.jsonl``."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from nanobot.config.paths import get_legacy_sessions_dir
from nanobot.session.manager import Session, SessionManager
from nanobot.utils.helpers import safe_filename

from console.server.bot_workspace import workspace_root


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
