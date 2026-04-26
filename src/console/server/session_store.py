"""Read/write nanobot chat sessions under ``<workspace>/sessions/*.jsonl``."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from console.server.bot_workspace import workspace_root
from console.server.nanobot_user_config import read_default_timezone, resolve_config_path
from nanobot.session.manager import Session, SessionManager, get_runtime_manager
from nanobot.utils.helpers import safe_filename


def _session_manager(bot_id: str | None) -> SessionManager:
    path = resolve_config_path(bot_id)
    return SessionManager(
        workspace_root(bot_id),
        timezone=read_default_timezone(path),
    )


_VALID_TRANSCRIPT_ROLES = frozenset({"user", "assistant", "system", "tool"})


def _transcript_file_path(ws: Path, session_key: str) -> Path:
    """Path to ``<workspace>/transcripts/{safe_key}.jsonl`` (matches ``SessionTranscriptWriter``)."""
    safe_key = safe_filename(session_key.replace(":", "_"))
    return ws / "transcripts" / f"{safe_key}.jsonl"


def _context_file_path(ws: Path, session_key: str) -> Path:
    """Path to ``<workspace>/context/{safe_key}.jsonl`` (matches ``SessionContextWriter``)."""
    safe_key = safe_filename(session_key.replace(":", "_"))
    return ws / "context" / f"{safe_key}.jsonl"


def _read_utf8_file(path: Path) -> str | None:
    """Return file contents, or ``None`` if the path is not a file or read fails."""
    if not path.is_file():
        return None
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return None


def _session_meta_path(ws: Path) -> Path:
    """Path to ``<workspace>/sessions/.meta.json`` (session display metadata)."""
    return ws / "sessions" / ".meta.json"


def _load_session_meta(bot_id: str | None) -> dict[str, Any]:
    """Read session display metadata map from disk."""
    path = _session_meta_path(workspace_root(bot_id))
    text = _read_utf8_file(path)
    if text is None:
        return {}
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return {}
    if not isinstance(data, dict):
        return {}
    return data


def _save_session_meta(bot_id: str | None, data: dict[str, Any]) -> None:
    """Persist session display metadata map."""
    path = _session_meta_path(workspace_root(bot_id))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )


def get_session_custom_title(bot_id: str | None, session_key: str) -> str | None:
    """Return user-defined title from ``sessions/.meta.json`` if present."""
    meta = _load_session_meta(bot_id)
    row = meta.get(session_key)
    if not isinstance(row, dict):
        return None
    title = row.get("title")
    if not isinstance(title, str):
        return None
    title = title.strip()
    return title or None


def set_session_custom_title(
    bot_id: str | None,
    session_key: str,
    title: str | None,
) -> None:
    """Set or clear user-defined title for one session."""
    meta = _load_session_meta(bot_id)
    normalized = (title or "").strip()
    if normalized:
        row = meta.get(session_key)
        if not isinstance(row, dict):
            row = {}
        row["title"] = normalized
        meta[session_key] = row
    else:
        if session_key in meta:
            meta.pop(session_key, None)
    _save_session_meta(bot_id, meta)


def _parse_transcript_jsonl_text(text: str) -> list[dict[str, Any]]:
    """Parse transcript JSONL text into message dicts in line order (see ``parse_transcript_jsonl``)."""
    out: list[dict[str, Any]] = []
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


def parse_transcript_jsonl(path: Path) -> list[dict[str, Any]]:
    """Read append-only transcript JSONL and return chat message dicts in file order.

    Skips compaction / eviction records (``_event``) and non-message rows so the result
    is a linear history suitable for UI replay without duplicating evicted lines.
    """
    text = _read_utf8_file(path)
    if text is None:
        return []
    return _parse_transcript_jsonl_text(text)


def load_transcript_messages(bot_id: str | None, session_key: str) -> list[dict[str, Any]] | None:
    """Load messages from ``workspace/transcripts/{key}.jsonl``.

    Returns ``None`` if the transcript file is absent (caller may fall back to session JSONL).
    Returns an empty list if the file exists but yields no message lines.
    """
    path = _transcript_file_path(workspace_root(bot_id), session_key)
    text = _read_utf8_file(path)
    if text is None:
        return None
    return _parse_transcript_jsonl_text(text)


def _primary_and_legacy_paths(mgr: SessionManager, key: str) -> tuple[Path, Path]:
    """Current workspace session file and legacy global path (``SessionManager``)."""
    return (mgr._get_session_path(key), mgr._get_legacy_session_path(key))


def _count_jsonl_messages(path: Path) -> int:
    """Count chat message lines (exclude leading metadata row if present)."""
    text = _read_utf8_file(path)
    if text is None:
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


def _coerce_message_content(raw: Any) -> str:
    """Convert a JSONL message ``content`` field to displayable text."""
    if isinstance(raw, str):
        return raw.strip()
    if raw is None:
        return ""
    return str(raw).strip()


def _collect_message_preview_from_text(
    text: str,
) -> tuple[str | None, str | None]:
    """Return ``(title, last_message)`` from transcript/session JSONL text.

    Title uses the first non-empty user message (mainstream chat UX). Last message
    uses the latest non-empty user/assistant/system/tool message.
    """
    title: str | None = None
    last_message: str | None = None
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            data = json.loads(stripped)
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
        content = _coerce_message_content(data.get("content"))
        if not content:
            continue
        if role == "user" and title is None:
            # Keep the first line concise for sidebar readability.
            first_line = content.splitlines()[0].strip()
            title = first_line[:80] if len(first_line) > 80 else first_line
        last_message = content
    return title, last_message


def load_session_preview(bot_id: str | None, session_key: str) -> tuple[str | None, str | None]:
    """Resolve sidebar preview metadata for one session.

    Prefers append-only transcript JSONL when present (new runtime path), then
    falls back to the session JSONL file.
    """
    custom_title = get_session_custom_title(bot_id, session_key)
    ws = workspace_root(bot_id)
    tr_path = _transcript_file_path(ws, session_key)
    tr_text = _read_utf8_file(tr_path)
    if tr_text is not None:
        title, last_message = _collect_message_preview_from_text(tr_text)
        return custom_title or title, last_message
    mgr = _session_manager(bot_id)
    for path in _primary_and_legacy_paths(mgr, session_key):
        text = _read_utf8_file(path)
        if text is not None:
            title, last_message = _collect_message_preview_from_text(text)
            return custom_title or title, last_message
    return custom_title, None


def list_session_rows(bot_id: str | None) -> list[dict[str, Any]]:
    """Return session list entries with keys, timestamps, and message counts."""
    mgr = _session_manager(bot_id)
    rows = mgr.list_sessions()
    out: list[dict[str, Any]] = []
    for row in rows:
        path = Path(row["path"])
        key = str(row["key"])
        title, last_message = load_session_preview(bot_id, key)
        out.append(
            {
                "key": key,
                "created_at": row.get("created_at"),
                "updated_at": row.get("updated_at"),
                "message_count": _count_jsonl_messages(path),
                "title": title,
                "last_message": last_message,
            }
        )
    return out


def load_session(bot_id: str | None, session_key: str) -> Session | None:
    """Load a session from disk, or ``None`` if it does not exist."""
    mgr = _session_manager(bot_id)
    return mgr._load(session_key)


def save_empty_session(bot_id: str | None, session_key: str) -> Session:
    """Create a new empty session file if missing (POST /sessions)."""
    mgr = _session_manager(bot_id)
    existing = mgr._load(session_key)
    if existing is not None:
        return existing
    session = Session(key=session_key, agent_timezone=mgr.agent_timezone)
    mgr.save(session)
    return session


def read_session_jsonl_raw(bot_id: str | None, session_key: str) -> str | None:
    """Return verbatim UTF-8 text of ``<workspace>/sessions/{key}.jsonl`` (or legacy path).

    Returns ``None`` if no session file exists.
    """
    mgr = _session_manager(bot_id)
    for path in _primary_and_legacy_paths(mgr, session_key):
        text = _read_utf8_file(path)
        if text is not None:
            return text
    return None


def read_transcript_jsonl_raw(bot_id: str | None, session_key: str) -> str | None:
    """Return verbatim UTF-8 text of ``<workspace>/transcripts/{key}.jsonl`` if the file exists."""
    return _read_utf8_file(_transcript_file_path(workspace_root(bot_id), session_key))


def read_context_jsonl_raw(bot_id: str | None, session_key: str) -> str | None:
    """Return verbatim UTF-8 text of ``<workspace>/context/{key}.jsonl`` if present."""
    return _read_utf8_file(_context_file_path(workspace_root(bot_id), session_key))


def load_context_entries(bot_id: str | None, session_key: str) -> list[dict[str, Any]] | None:
    """Parse the per-turn context JSONL into a list of dict records.

    Returns ``None`` when the file does not exist; returns ``[]`` when the file
    exists but contains no valid lines.  Malformed JSON lines are skipped so a
    partial write never prevents the UI from loading older snapshots.
    """
    text = read_context_jsonl_raw(bot_id, session_key)
    if text is None:
        return None
    entries: list[dict[str, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(record, dict):
            entries.append(record)
    return entries


def delete_session_files(bot_id: str | None, session_key: str) -> bool:
    """Delete session JSONL from workspace and legacy global dir.

    When a session file is removed, also deletes the matching append-only transcript
    at ``<workspace>/transcripts/{safe_key}.jsonl`` (see ``SessionTranscriptWriter``)
    and the observability JSONL tree at ``<workspace>/observability/sessions/{safe_key}/``.

    Returns True if at least one session file was removed.
    """
    mgr = _session_manager(bot_id)
    removed = False
    for path in _primary_and_legacy_paths(mgr, session_key):
        if path.is_file():
            path.unlink()
            removed = True
    if removed:
        set_session_custom_title(bot_id, session_key, None)
        tr_path = _transcript_file_path(workspace_root(bot_id), session_key)
        if tr_path.is_file():
            tr_path.unlink()
        ctx_path = _context_file_path(workspace_root(bot_id), session_key)
        if ctx_path.is_file():
            ctx_path.unlink()
        obs_sess = (
            workspace_root(bot_id)
            / "observability"
            / "sessions"
            / safe_filename(session_key.replace(":", "_"))
        )
        if obs_sess.is_dir():
            shutil.rmtree(obs_sess)
    # The throwaway ``mgr`` above has an empty cache; the agent loop owns
    # the long-lived SessionManager that may still hold this session in
    # memory. Without this hand-off the entry would be re-flushed on
    # shutdown, resurrecting the session the user just deleted.
    mgr.invalidate(session_key)
    runtime_mgr = get_runtime_manager(workspace_root(bot_id))
    if runtime_mgr is not None and runtime_mgr is not mgr:
        runtime_mgr.invalidate(session_key)
    return removed
