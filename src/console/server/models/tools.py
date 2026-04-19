"""Tool call log models."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict


class ToolCallLog(BaseModel):
    """Single tool invocation log row."""

    model_config = ConfigDict(extra="forbid")

    id: str
    tool_name: str
    arguments: dict[str, Any]
    result: str | None = None
    status: Literal["success", "error"]
    duration_ms: float
    timestamp: str
