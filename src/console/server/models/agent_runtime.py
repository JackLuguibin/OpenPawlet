"""Runtime agent lifecycle models for unified manager APIs.

Field layout matches :class:`openpawlet.runtime.agent_manager.ManagedAgentStatus`
so :meth:`~RuntimeAgentStatus.model_validate` can consume runtime rows directly.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class RuntimeAgentStatus(BaseModel):
    """Unified runtime status for main or subagent (HTTP projection)."""

    model_config = ConfigDict(extra="forbid")

    agent_id: str
    role: str
    running: bool
    phase: str | None = None
    started_at: float | None = None
    uptime_seconds: float | None = None
    parent_agent_id: str | None = None
    team_id: str | None = None
    label: str | None = None
    task_description: str | None = None
    iteration: int | None = None
    stop_reason: str | None = None
    error: str | None = None
    session_key: str | None = None
    parent_session_key: str | None = None
    profile_id: str | None = None


class RuntimeControlResult(BaseModel):
    """Result payload for runtime start/stop actions."""

    model_config = ConfigDict(extra="forbid")

    agent_id: str
    changed: bool
    running: bool
    message: str


class RuntimeSubagentStartBody(BaseModel):
    """Request body for starting a managed subagent."""

    model_config = ConfigDict(extra="forbid")

    task: str
    label: str | None = None
    parent_agent_id: str | None = None
    team_id: str | None = None
    origin_channel: str | None = None
    origin_chat_id: str | None = None
    session_key: str | None = None
    profile_id: str | None = None

