"""Mapping from raw ``session_store`` rows to API ``SessionInfo`` payloads.

Both the HTTP sessions router and the websocket state hub need to render
the same shape; centralizing the conversion here lets them share a single
implementation without one importing the other.
"""

from __future__ import annotations

import re

from openpawlet.utils.background_session import is_background_ephemeral_session_key

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


def session_key_is_ephemeral_sidebar(key: str) -> bool:
    """Whether *key* belongs in the console sidebar temporary/background group."""
    team_id, room_id, agent_id = parse_team_session_key(key)
    is_sub, _, _ = parse_subagent_key(key)
    return bool(
        team_id is None
        and room_id is None
        and agent_id is None
        and not is_sub
        and is_background_ephemeral_session_key(key)
    )


def _workspace_agent_display_names(bot_id: str | None) -> dict[str, str]:
    """Map Console agent id → display label (name, or id if name is blank)."""
    try:
        from console.server.services.agents_state import list_agents

        return {
            a.id: ((a.name or "").strip() or a.id) for a in list_agents(bot_id)
        }
    except Exception:  # noqa: BLE001 - enrichment must not break session listing
        return {}


def attach_session_agent_names(
    bot_id: str | None, infos: list[SessionInfo]
) -> list[SessionInfo]:
    """Fill ``agent_name`` when ``agent_id`` matches a workspace agent or gateway alias."""
    if not infos or not any(info.agent_id for info in infos):
        return infos
    name_by_id = _workspace_agent_display_names(bot_id)
    if not name_by_id:
        return infos

    logical_gateway: str | None = None
    try:
        from console.server.bot_workspace import workspace_root
        from openpawlet.utils.team_gateway_runtime import (
            resolve_effective_gateway_agent_id,
        )

        ws = workspace_root(bot_id)
        logical_gateway = resolve_effective_gateway_agent_id(ws)
    except Exception:  # noqa: BLE001 - enrichment must not break session listing
        logical_gateway = None

    out: list[SessionInfo] = []
    for info in infos:
        aid = info.agent_id
        if not aid:
            out.append(info)
            continue
        if aid in name_by_id:
            out.append(info.model_copy(update={"agent_name": name_by_id[aid]}))
            continue

        mapped: str | None = None
        if logical_gateway and logical_gateway in name_by_id:
            if aid.startswith(f"{logical_gateway}:"):
                mapped = name_by_id[logical_gateway]
        if mapped is None and aid.startswith("main:") and "main" in name_by_id:
            mapped = name_by_id["main"]
        if mapped is not None:
            out.append(info.model_copy(update={"agent_name": mapped}))
        else:
            out.append(info)

    return out


def with_session_agent_name(bot_id: str | None, info: SessionInfo) -> SessionInfo:
    """Like :func:`attach_session_agent_names` for a single row."""
    return attach_session_agent_names(bot_id, [info])[0]


def row_to_session_info(row: dict[str, object]) -> SessionInfo:
    """Convert a ``session_store`` row dict into a ``SessionInfo`` payload."""
    key = str(row["key"])
    team_id, room_id, agent_id = parse_team_session_key(key)
    is_sub, parent_key, sub_task = parse_subagent_key(key)
    ephemeral = session_key_is_ephemeral_sidebar(key)
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
        ephemeral_session=ephemeral,
    )


__all__ = [
    "TEAM_SESSION_RE",
    "SUBAGENT_SESSION_RE",
    "parse_subagent_key",
    "parse_team_session_key",
    "attach_session_agent_names",
    "with_session_agent_name",
    "row_to_session_info",
    "session_key_is_ephemeral_sidebar",
]
