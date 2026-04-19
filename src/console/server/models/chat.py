"""Chat API models."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict


class ToolCall(BaseModel):
    """Tool invocation in chat."""

    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    arguments: dict[str, Any]


class ChatRequest(BaseModel):
    """POST /chat body."""

    model_config = ConfigDict(extra="forbid")

    session_key: str | None = None
    message: str
    stream: bool | None = None
    bot_id: str | None = None


class ChatResponse(BaseModel):
    """Non-streaming chat reply."""

    model_config = ConfigDict(extra="forbid")

    session_key: str
    message: str
    tool_calls: list[ToolCall] | None = None
    done: bool
