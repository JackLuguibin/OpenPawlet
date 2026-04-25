"""Team room session key helpers (single-gateway, multi-identity in-process)."""

from __future__ import annotations


def team_member_session_key(team_id: str, room_id: str, agent_id: str) -> str:
    """Durable key per parallel member; must match console merge API."""
    return f"console:team_{team_id}_room_{room_id}_agent_{agent_id}"
