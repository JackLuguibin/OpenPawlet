"""MCP operation models."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class MCPTestResult(BaseModel):
    """MCP test / refresh result."""

    model_config = ConfigDict(extra="forbid")

    name: str
    success: bool
    message: str | None = None
    latency_ms: float | None = None
