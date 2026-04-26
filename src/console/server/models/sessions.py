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
    team_id: str | None = None
    room_id: str | None = None
    agent_id: str | None = None


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


class SessionContextEntry(BaseModel):
    """One per-turn snapshot of the assembled LLM context.

    Matches the JSONL records written by ``SessionContextWriter`` and mirrors
    the fields the UI needs to present both a textual view and a structured
    breakdown of the exact prompt sent to the model on a given turn.
    """

    model_config = ConfigDict(extra="allow")

    session_key: str | None = None
    bot_id: str | None = None
    channel: str | None = None
    chat_id: str | None = None
    turn_index: int | None = None
    source: str | None = None
    timestamp: str | None = None
    system_prompt: str | None = None
    messages: list[Any] | None = None
    message_count: int | None = None
    context_text: str | None = None


class SessionContextPayload(BaseModel):
    """GET /sessions/{key}/context response.

    The writer overwrites ``<workspace>/context/{key}.jsonl`` with a single
    record on every turn, so this response carries only the latest snapshot
    (plus the raw file text for debug views).  ``latest`` is ``None`` when no
    turn has been recorded yet for this session.
    """

    model_config = ConfigDict(extra="forbid")

    key: str
    latest: SessionContextEntry | None = None
    text: str


class CreateSessionBody(BaseModel):
    """POST /sessions body."""

    model_config = ConfigDict(extra="forbid")

    key: str | None = None
    team_id: str | None = None
    room_id: str | None = None
    agent_id: str | None = None
    ephemeral_session: bool | None = None


class BatchDeleteBody(BaseModel):
    """DELETE /sessions/batch body."""

    model_config = ConfigDict(extra="forbid")

    keys: list[str]


class UpdateSessionBody(BaseModel):
    """PATCH /sessions/{key} body."""

    model_config = ConfigDict(extra="forbid")

    title: str | None = None


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
