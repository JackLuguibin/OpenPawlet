"""Workspace-driven team binding for gateway (active_team_gateway.json)."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from openpawlet.config.paths import workspace_console_subdir

ACTIVE_TEAM_GATEWAY_FILE = "active_team_gateway.json"


def team_member_session_key(
    team_id: str, room_id: str, agent_id: str, *, nonce: str | None = None
) -> str:
    """Build the session key for one team room member."""
    key = f"console:team_{team_id}_room_{room_id}_agent_{agent_id}"
    if nonce:
        return f"{key}_run_{nonce}"
    return key


def standalone_agent_session_key(agent_id: str) -> str:
    """Build the session key for a standalone (non-team) enabled agent.

    The standalone runtime loop subscribes to ``agent.<id>`` direct
    messages and broadcast topics under this key. Mirrors the team
    member key shape so :func:`should_handle_direct_for_session` and
    transcript writers can treat both the same way.
    """
    aid = (agent_id or "").strip()
    if not aid:
        raise ValueError("agent_id required for standalone session key")
    return f"console:agent_{aid}"


def load_all_team_member_bindings(workspace: Path) -> list[tuple[str, str, str, str]]:
    """Return all valid team-room-member bindings as tuples.

    Tuple format: ``(team_id, room_id, agent_id, session_key)``.
    """
    teams_raw = _load_teams_blob(workspace)
    if not teams_raw:
        return []
    teams = teams_raw.get("teams")
    rooms = teams_raw.get("rooms")
    if not isinstance(teams, list) or not isinstance(rooms, list):
        return []

    team_to_members: dict[str, list[str]] = {}
    for item in teams:
        if not isinstance(item, dict):
            continue
        tid = str(item.get("id", "")).strip()
        if not tid:
            continue
        raw_members = item.get("member_agent_ids")
        if not isinstance(raw_members, list):
            team_to_members[tid] = []
            continue
        members = [str(x).strip() for x in raw_members if str(x).strip()]
        team_to_members[tid] = members

    out: list[tuple[str, str, str, str]] = []
    for room in rooms:
        if not isinstance(room, dict):
            continue
        tid = str(room.get("team_id", "")).strip()
        rid = str(room.get("id", "")).strip()
        if not tid or not rid:
            continue
        for aid in team_to_members.get(tid, []):
            out.append((tid, rid, aid, team_member_session_key(tid, rid, aid)))
    out.sort(key=lambda x: (x[0], x[1], x[2], x[3]))
    return out


def active_team_gateway_path(workspace: Path) -> Path:
    return workspace_console_subdir(workspace) / ACTIVE_TEAM_GATEWAY_FILE


def load_active_team_gateway_file(workspace: Path) -> dict[str, Any] | None:
    path = active_team_gateway_path(workspace)
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeError):
        return None
    return raw if isinstance(raw, dict) else None


def _load_teams_blob(workspace: Path) -> dict[str, Any] | None:
    path = workspace_console_subdir(workspace) / "teams.json"
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeError):
        return None
    return raw if isinstance(raw, dict) else None


def resolve_gateway_team_context(
    workspace: Path,
) -> tuple[str | None, str | None, list[str]]:
    """Return ``(team_id, room_id, member_agent_ids)`` for in-process team loops.

    Precedence:
    1. ``OPENPAWLET_TEAM_ID`` + ``OPENPAWLET_TEAM_ROOM_ID`` when both set (legacy override).
    2. ``active_team_gateway.json`` + ``teams.json`` when valid.
    """
    env_tid = os.environ.get("OPENPAWLET_TEAM_ID", "").strip()
    env_rid = os.environ.get("OPENPAWLET_TEAM_ROOM_ID", "").strip()
    if env_tid and env_rid:
        members = _members_from_env_or_teams(workspace, env_tid)
        return env_tid, env_rid, members

    blob = load_active_team_gateway_file(workspace)
    if not isinstance(blob, dict):
        return None, None, []
    tid = str(blob.get("team_id", "")).strip()
    rid = str(blob.get("room_id", "")).strip()
    if not tid or not rid:
        return None, None, []

    teams_raw = _load_teams_blob(workspace)
    if not teams_raw:
        return None, None, []
    rooms = teams_raw.get("rooms")
    teams = teams_raw.get("teams")
    if not isinstance(rooms, list) or not isinstance(teams, list):
        return None, None, []
    if not any(
        isinstance(r, dict) and str(r.get("id", "")) == rid and str(r.get("team_id", "")) == tid
        for r in rooms
    ):
        return None, None, []
    team_row = next(
        (t for t in teams if isinstance(t, dict) and str(t.get("id", "")) == tid),
        None,
    )
    if not isinstance(team_row, dict):
        return None, None, []
    raw_m = team_row.get("member_agent_ids")
    if not isinstance(raw_m, list):
        return tid, rid, []
    members = [str(x).strip() for x in raw_m if str(x).strip()]
    return tid, rid, members


def _members_from_env_or_teams(workspace: Path, team_id: str) -> list[str]:
    csv = os.environ.get("OPENPAWLET_TEAM_MEMBER_IDS", "").strip()
    if csv:
        return [x.strip() for x in csv.split(",") if x.strip()]
    teams_raw = _load_teams_blob(workspace)
    if not teams_raw:
        return []
    teams = teams_raw.get("teams")
    if not isinstance(teams, list):
        return []
    for item in teams:
        if isinstance(item, dict) and str(item.get("id", "")) == team_id:
            raw_m = item.get("member_agent_ids")
            if isinstance(raw_m, list):
                return [str(x).strip() for x in raw_m if str(x).strip()]
            return []
    return []


def resolve_effective_gateway_agent_id(workspace: Path) -> str | None:
    """Resolve logical agent_id when :envvar:`OPENPAWLET_AGENT_ID` is unset.

    Team ``send_to_agent`` / broker routing use ``agent:<id>``; the gateway
    process must use the *same* id as the console, not only the ambient
    default ``agent:main`` identity.

    Heuristics (first match):
    1. Exactly one ``workspace/agents/<id>.json`` file → that *id*.
    2. Multiple agent files, but only one is listed in the active team’s
       ``member_agent_ids`` (from :func:`resolve_gateway_team_context`) → that *id*.

    Returns ``None`` if ambiguous; caller should keep
    :class:`~openpawlet.agent.loop.AgentLoop`’s default identity.
    """
    adir = workspace / "agents"
    if not adir.is_dir():
        return None
    stems: list[str] = sorted(
        p.stem for p in adir.glob("*.json") if p.is_file() and p.stem and ".." not in p.stem
    )
    if not stems:
        return None
    if len(stems) == 1:
        return stems[0]
    _tid, _rid, members = resolve_gateway_team_context(workspace)
    if not members:
        return None
    mset = {m for m in members if m}
    overlap = [s for s in stems if s in mset]
    if len(overlap) == 1:
        return overlap[0]
    return None
