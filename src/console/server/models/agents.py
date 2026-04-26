"""Agent and multi-agent models (aligned with web ``types_agents.ts``)."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class Agent(BaseModel):
    """Agent record."""

    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    description: str | None
    model: str | None
    temperature: float | None
    system_prompt: str | None
    skills: list[str]
    topics: list[str]
    collaborators: list[str]
    enabled: bool
    created_at: str
    team_ids: list[str] = Field(default_factory=list)
    # Independent persona / tool overrides (None = inherit from main agent).
    max_tokens: int | None = None
    max_tool_iterations: int | None = None
    max_tool_result_chars: int | None = None
    context_window_tokens: int | None = None
    reasoning_effort: str | None = None
    timezone: str | None = None
    web_enabled: bool | None = None
    exec_enabled: bool | None = None
    mcp_servers_allowlist: list[str] | None = None
    allowed_tools: list[str] | None = None
    skills_denylist: list[str] = Field(default_factory=list)
    use_own_bootstrap: bool = True
    inherit_main_bootstrap: bool = False
    # Read-only flags reflecting whether this agent's bootstrap files exist
    # under ``<workspace>/agents/<id>/``. The router populates these on read;
    # ignored on write.
    has_soul: bool = False
    has_user: bool = False
    has_agents_md: bool = False
    has_tools_md: bool = False


class AgentCreateRequest(BaseModel):
    """POST create agent body."""

    model_config = ConfigDict(extra="forbid")

    id: str | None = None
    name: str
    description: str | None = None
    model: str | None = None
    temperature: float | None = None
    system_prompt: str | None = None
    skills: list[str] | None = None
    topics: list[str] | None = None
    collaborators: list[str] | None = None
    enabled: bool | None = None
    max_tokens: int | None = None
    max_tool_iterations: int | None = None
    max_tool_result_chars: int | None = None
    context_window_tokens: int | None = None
    reasoning_effort: str | None = None
    timezone: str | None = None
    web_enabled: bool | None = None
    exec_enabled: bool | None = None
    mcp_servers_allowlist: list[str] | None = None
    allowed_tools: list[str] | None = None
    skills_denylist: list[str] | None = None
    use_own_bootstrap: bool | None = None
    inherit_main_bootstrap: bool | None = None


class AgentUpdateRequest(BaseModel):
    """PUT update agent body."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    description: str | None = None
    model: str | None = None
    temperature: float | None = None
    system_prompt: str | None = None
    skills: list[str] | None = None
    topics: list[str] | None = None
    collaborators: list[str] | None = None
    enabled: bool | None = None
    max_tokens: int | None = None
    max_tool_iterations: int | None = None
    max_tool_result_chars: int | None = None
    context_window_tokens: int | None = None
    reasoning_effort: str | None = None
    timezone: str | None = None
    web_enabled: bool | None = None
    exec_enabled: bool | None = None
    mcp_servers_allowlist: list[str] | None = None
    allowed_tools: list[str] | None = None
    skills_denylist: list[str] | None = None
    use_own_bootstrap: bool | None = None
    inherit_main_bootstrap: bool | None = None


class AgentStatus(BaseModel):
    """GET /agents/{id}/status."""

    model_config = ConfigDict(extra="forbid")

    agent_id: str
    agent_name: str
    enabled: bool
    total_agents: int
    enabled_agents: int
    subscribed_agents: list[str]
    zmq_initialized: bool
    current_agent_id: str | None


class AgentsSystemStatus(BaseModel):
    """GET /system-status/status."""

    model_config = ConfigDict(extra="forbid")

    total_agents: int
    enabled_agents: int
    subscribed_agents: list[str]
    zmq_initialized: bool
    current_agent_id: str | None


class CategoryInfo(BaseModel):
    """Agent category label."""

    model_config = ConfigDict(extra="forbid")

    key: str
    label: str
    color: str


class AddCategoryBody(BaseModel):
    """POST /categories body."""

    model_config = ConfigDict(extra="forbid")

    label: str


class CategoryOverrideBody(BaseModel):
    """PUT /categories/overrides body."""

    model_config = ConfigDict(extra="forbid")

    agent_id: str
    category_key: str | None = None


class DelegateTaskRequest(BaseModel):
    """POST delegate body."""

    model_config = ConfigDict(extra="forbid")

    to_agent_id: str
    task: str
    context: dict[str, Any] | None = None
    wait_response: bool | None = None


class DelegateTaskResponse(BaseModel):
    """Delegate response."""

    model_config = ConfigDict(extra="forbid")

    correlation_id: str
    response: str | None


class BroadcastEventRequest(BaseModel):
    """POST broadcast body."""

    model_config = ConfigDict(extra="forbid")

    topic: str
    content: str
    context: dict[str, Any] | None = None


class AgentBootstrapFiles(BaseModel):
    """GET /agents/{id}/bootstrap response.

    Each field carries the markdown content for the named bootstrap file
    under ``<workspace>/agents/<agent_id>/``. Empty string means the
    file does not exist (caller may then fall back to main bootstrap).
    """

    model_config = ConfigDict(extra="forbid")

    soul: str = ""
    user: str = ""
    agents: str = ""
    tools: str = ""


class AgentBootstrapUpdateBody(BaseModel):
    """PUT /agents/{id}/bootstrap/{key} body."""

    model_config = ConfigDict(extra="forbid")

    content: str


def placeholder_agent(*, agent_id: str = "stub-agent") -> Agent:
    """Return a minimal valid agent row for stub responses."""
    return Agent(
        id=agent_id,
        name="Stub Agent",
        description=None,
        model=None,
        temperature=None,
        system_prompt=None,
        skills=[],
        topics=[],
        collaborators=[],
        enabled=False,
        created_at="1970-01-01T00:00:00Z",
    )


def placeholder_category(key: str = "default") -> CategoryInfo:
    """Return a stub category row."""
    return CategoryInfo(key=key, label="Default", color="#888888")
