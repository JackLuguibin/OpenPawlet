"""Team room session keys and merged transcript for parallel agent runs."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from console.server.session_store import load_session, load_transcript_messages


def team_member_session_key(
    team_id: str, room_id: str, agent_id: str, *, nonce: str | None = None
) -> str:
    """One session file per team room member (avoid multi-writer on one key)."""
    key = f"console:team_{team_id}_room_{room_id}_agent_{agent_id}"
    if nonce:
        return f"{key}_run_{nonce}"
    return key


def _parse_ts(s: str | None) -> float:
    if not s or not str(s).strip():
        return float("inf")
    try:
        t = str(s).strip()
        if t.endswith("Z"):
            t = t[:-1] + "+00:00"
        return datetime.fromisoformat(t).timestamp()
    except (ValueError, TypeError, OSError):
        return float("inf")


def load_messages_for_key(bot_id: str | None, session_key: str) -> list[dict[str, Any]]:
    """Transcript when present, else in-memory session store messages (same as sessions API)."""
    tmsgs = load_transcript_messages(bot_id, session_key)
    if tmsgs is None:
        session = load_session(bot_id, session_key)
        if session is None:
            return []
        return list(session.messages)
    return tmsgs


def merge_team_transcript(
    bot_id: str | None,
    *,
    team_id: str,
    room_id: str,
    member_agent_ids: list[str],
    id_to_name: dict[str, str],
) -> tuple[dict[str, str], list[dict[str, Any]]]:
    """Return (member_session_keys, merged_enriched_rows).

    Each row: agent_id, agent_name, session_key, role, content, timestamp, source.
    """
    keys: dict[str, str] = {}
    rows: list[dict[str, Any]] = []
    for aid in member_agent_ids:
        sk = team_member_session_key(team_id, room_id, aid)
        keys[aid] = sk
        msgs = load_messages_for_key(bot_id, sk)
        for m in msgs:
            if not isinstance(m, dict):
                continue
            role = m.get("role")
            if role not in ("user", "assistant", "system", "tool"):
                continue
            raw_content = m.get("content", "")
            text = raw_content if isinstance(raw_content, str) else str(raw_content)
            rows.append(
                {
                    "agent_id": aid,
                    "agent_name": id_to_name.get(aid),
                    "session_key": sk,
                    "role": role,
                    "content": text,
                    "timestamp": m.get("timestamp") if isinstance(m.get("timestamp"), str) else None,
                    "source": m.get("source") if isinstance(m.get("source"), str) else None,
                    "_sort": _parse_ts(m.get("timestamp") if isinstance(m.get("timestamp"), str) else None),
                }
            )
    for i, r in enumerate(rows):
        r["_ord"] = i
    rows.sort(key=lambda r: (r.get("_sort", 0.0), r.get("session_key", ""), r.get("_ord", 0)))
    for r in rows:
        r.pop("_sort", None)
        r.pop("_ord", None)
    return keys, rows
