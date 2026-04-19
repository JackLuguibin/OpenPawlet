"""Runtime status models (aligned with web ``types.ts``)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict


class ChannelStatus(BaseModel):
    """Per-channel connectivity snapshot."""

    model_config = ConfigDict(extra="forbid")

    name: str
    enabled: bool
    status: Literal["online", "offline", "error"]
    stats: dict[str, Any]


class MCPStatus(BaseModel):
    """MCP server row."""

    model_config = ConfigDict(extra="forbid")

    name: str
    status: Literal["connected", "disconnected", "error"]
    server_type: Literal["stdio", "http"]
    last_connected: str | None = None
    error: str | None = None


class TokenUsage(BaseModel):
    """Token and cost usage summary."""

    model_config = ConfigDict(extra="forbid")

    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_tokens: int | None = None
    by_model: dict[str, dict[str, int | None]] | None = None
    cost_usd: float | None = None
    cost_by_model: dict[str, float] | None = None


class StatusResponse(BaseModel):
    """GET /status aggregate."""

    model_config = ConfigDict(extra="forbid")

    running: bool
    uptime_seconds: float
    model: str | None = None
    active_sessions: int
    messages_today: int
    token_usage: TokenUsage | None = None
    channels: list[ChannelStatus]
    mcp_servers: list[MCPStatus]


def placeholder_status() -> StatusResponse:
    """Empty aggregate status for stub responses."""
    return StatusResponse(
        running=False,
        uptime_seconds=0.0,
        active_sessions=0,
        messages_today=0,
        channels=[],
        mcp_servers=[],
    )
