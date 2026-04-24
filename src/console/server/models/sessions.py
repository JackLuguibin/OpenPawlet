"""Session models."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict


class Message(BaseModel):
    """Chat message (subset for session detail)."""

    model_config = ConfigDict(extra="forbid")

    role: Literal["user", "assistant", "system", "tool"]
    content: str
    tool_call_id: str | None = None
    tool_name: str | None = None
    timestamp: str | None = None
    source: str | None = None


class SessionInfo(BaseModel):
    """Session list row."""

    model_config = ConfigDict(extra="forbid")

    key: str
    title: str | None = None
    message_count: int
    last_message: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class SessionDetail(SessionInfo):
    """Session with optional preview messages."""

    preview_messages: list[Message] | None = None


class SessionMessagesPayload(BaseModel):
    """GET /sessions/{key} when ``detail`` is false (legacy shape).

    Extended with pagination metadata for ``/transcript`` lazy loading:

    - ``offset`` is the absolute index (0-based) of the first returned message
      within the full transcript.
    - ``total`` is the total number of messages in the transcript (or ``None``
      when pagination was not applied / unknown).
    - ``has_more`` indicates whether older messages exist before ``offset``.

    All three fields default to ``None`` / ``False`` so legacy clients that
    request the full history continue to see the same shape.
    """

    model_config = ConfigDict(extra="forbid")

    key: str
    messages: list[Any]
    message_count: int
    offset: int | None = None
    total: int | None = None
    has_more: bool = False


class SessionJsonlRawPayload(BaseModel):
    """Raw JSONL file contents for debugging (session store or append-only transcript)."""

    model_config = ConfigDict(extra="forbid")

    key: str
    source: Literal["session", "transcript"]
    text: str


class CreateSessionBody(BaseModel):
    """POST /sessions body."""

    model_config = ConfigDict(extra="forbid")

    key: str | None = None


class BatchDeleteBody(BaseModel):
    """DELETE /sessions/batch body."""

    model_config = ConfigDict(extra="forbid")

    keys: list[str]


class BatchDeleteFailure(BaseModel):
    """Per-key failure in batch delete."""

    model_config = ConfigDict(extra="forbid")

    key: str
    error: str


class BatchDeleteResponse(BaseModel):
    """Batch delete outcome."""

    model_config = ConfigDict(extra="forbid")

    deleted: list[str]
    failed: list[BatchDeleteFailure]
