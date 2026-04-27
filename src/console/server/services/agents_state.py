"""Read-side helpers for the agents persistence layout (``workspace/agents/``).

This module exists so non-router callers (e.g. the teams router and websocket
state helpers) do not have to import private ``_load_raw_state`` /
``_parse_agents`` from ``console.server.routers.v1.agents``.
"""

from __future__ import annotations

from console.server.models import Agent


def list_agent_ids(bot_id: str) -> set[str]:
    """Return the set of agent ids currently registered for ``bot_id``."""
    return {a.id for a in list_agents(bot_id)}


def list_agents(bot_id: str) -> list[Agent]:
    """Return parsed ``Agent`` objects for ``bot_id``.

    The router module owns the actual file layout / migration logic; this
    helper imports it lazily to break the circular dependency between
    ``teams`` and ``agents`` routers.
    """
    from console.server.routers.v1.agents import _load_raw_state, _parse_agents

    raw = _load_raw_state(bot_id)
    return _parse_agents(raw["agents"])


__all__ = ["list_agent_ids", "list_agents"]
