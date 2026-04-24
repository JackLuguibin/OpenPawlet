"""Event types for the message bus.

Both :class:`InboundMessage` and :class:`OutboundMessage` carry the
fields required by the ZeroMQ-backed Queue Manager (``message_id``,
``dedupe_key``, ``event_seq`` and ``trace_id``) as optional attributes.
They keep sensible defaults so in-process call sites that predate the
unified queue continue to work without modification.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from nanobot.bus.envelope import (
    build_dedupe_key,
    new_message_id,
    new_trace_id,
)


@dataclass
class InboundMessage:
    """Message received from a chat channel."""

    channel: str  # telegram, discord, slack, whatsapp
    sender_id: str  # User identifier
    chat_id: str  # Chat/channel identifier
    content: str  # Message text
    timestamp: datetime = field(default_factory=datetime.now)
    media: list[str] = field(default_factory=list)  # Media URLs
    metadata: dict[str, Any] = field(default_factory=dict)  # Channel-specific data
    session_key_override: str | None = None  # Optional override for thread-scoped sessions
    # Queue Manager envelope fields - excluded from equality so legacy
    # assertions such as ``assert msg == InboundMessage(...)`` stay valid
    # regardless of the auto-generated message_id / trace_id.
    message_id: str = field(default_factory=new_message_id, compare=False)
    dedupe_key: str | None = field(default=None, compare=False)
    event_seq: int = field(default=0, compare=False)
    trace_id: str = field(default_factory=new_trace_id, compare=False)
    attempt: int = field(default=0, compare=False)

    def __post_init__(self) -> None:
        # Derive a default dedupe_key so downstream stores never see a
        # missing value. Consumers that want a custom bucket should pass
        # one explicitly before publishing.
        if not self.dedupe_key:
            self.dedupe_key = build_dedupe_key(
                channel=self.channel,
                chat_id=self.chat_id,
                message_id=self.message_id,
            )

    @property
    def session_key(self) -> str:
        """Unique key for session identification."""
        return self.session_key_override or f"{self.channel}:{self.chat_id}"


@dataclass
class OutboundMessage:
    """Message to send to a chat channel."""

    channel: str
    chat_id: str
    content: str
    reply_to: str | None = None
    media: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    # Envelope fields - excluded from equality, see InboundMessage.
    message_id: str = field(default_factory=new_message_id, compare=False)
    dedupe_key: str | None = field(default=None, compare=False)
    event_seq: int = field(default=0, compare=False)
    trace_id: str = field(default_factory=new_trace_id, compare=False)
    attempt: int = field(default=0, compare=False)

    def __post_init__(self) -> None:
        if not self.dedupe_key:
            self.dedupe_key = build_dedupe_key(
                channel=self.channel,
                chat_id=self.chat_id,
                message_id=self.message_id,
            )
