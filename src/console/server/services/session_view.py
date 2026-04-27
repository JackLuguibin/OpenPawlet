"""Mapping from raw ``session_store`` rows to API ``SessionInfo`` payloads.

Both the HTTP sessions router and the websocket state hub need to render
the same shape; centralizing the conversion here lets them share a single
implementation without one importing the other.
"""

from __future__ import annotations

import re

from console.server.models import SessionInfo

# Public regex constants — re-exported so other modules don't have to keep
# their own copy in sync.  Naming follows the public/upper-case convention
# documented in PEP 8 for module-level constants.
TEAM_SESSION_RE = re.compile(
    r"^console:team_(?P<team_id>[^_]+)_room_(?P<room_id>[^_]+)_agent_(?P<agent_id>.+?)(?:_run_[^_]+)?$"
)

# Sub-agent transcripts use ``subagent:<parent_session_key>:<8-char-task-id>``;
# the parent portion may itself contain colons (e.g. ``cli:direct``) so the
# parent group is greedy up to the final ``:<task_id>`` suffix.
SUBAGENT_SESSION_RE = re.compile(
    r"^subagent:(?P<parent>.+):(?P<task>[0-9a-f]{8})$"
)


def parse_subagent_key(key: str) -> tuple[bool, str | None, str | None]:
    """Return ``(is_subagent, parent_session_key, task_id)`` for *key*."""
    match = SUBAGENT_SESSION_RE.match(key)
    if not match:
        return False, None, None
    parent = match.group("parent")
    if parent == "orphan":
        parent = None
    return True, parent, match.group("task")


def parse_team_session_key(
    key: str,
) -> tuple[str | None, str | None, str | None]:
    """Return ``(team_id, room_id, agent_id)`` for a team session key.

    Returns ``(None, None, None)`` when *key* does not match the pattern.
    """
    match = TEAM_SESSION_RE.match(key)
    if not match:
        return None, None, None
    return match.group("team_id"), match.group("room_id"), match.group("agent_id")


def _coerce_optional_str(value: object) -> str | None:
    """Coerce ``value`` to ``str`` while preserving ``None``."""
    return None if value is None else str(value)


def row_to_session_info(row: dict[str, object]) -> SessionInfo:
    """Convert a ``session_store`` row dict into a ``SessionInfo`` payload."""
    key = str(row["key"])
    team_id, room_id, agent_id = parse_team_session_key(key)
    is_sub, parent_key, sub_task = parse_subagent_key(key)
    return SessionInfo(
        key=key,
        title=_coerce_optional_str(row.get("title")),
        message_count=int(row["message_count"]),
        last_message=_coerce_optional_str(row.get("last_message")),
        created_at=_coerce_optional_str(row.get("created_at")),
        updated_at=_coerce_optional_str(row.get("updated_at")),
        team_id=team_id,
        room_id=room_id,
        agent_id=agent_id,
        is_subagent=is_sub,
        subagent_task_id=sub_task,
        parent_session_key=parent_key,
    )


__all__ = [
    "TEAM_SESSION_RE",
    "SUBAGENT_SESSION_RE",
    "parse_subagent_key",
    "parse_team_session_key",
    "row_to_session_info",
]
