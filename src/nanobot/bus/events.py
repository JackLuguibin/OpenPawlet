"""Event types for the message bus.

Both :class:`InboundMessage` and :class:`OutboundMessage` carry the
fields required by the ZeroMQ-backed Queue Manager (``message_id``,
``dedupe_key``, ``event_seq`` and ``trace_id``) as optional attributes.
They keep sensible defaults so in-process call sites that predate the
unified queue continue to work without modification.
"""

import json
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from nanobot.bus.envelope import (
    KEY_CORRELATION_ID,
    KEY_EXPECTS_REPLY,
    KEY_REPLY_ERROR,
    KEY_SOURCE_SESSION_KEY,
    KEY_TARGET_SESSION_KEY,
    TARGET_BROADCAST,
    TOPIC_AGENT_REQUEST_REPLY,
    build_dedupe_key,
    new_message_id,
    new_trace_id,
    produced_at,
    target_for_agent,
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
    # Optional layout-preserving button labels (one row per outer list).
    # Channels that support inline keyboards can render them natively;
    # other channels splice the labels back into the message text so the
    # user always sees the available options. ``[]`` means "no buttons" —
    # all existing channels are unaffected when this stays at default.
    buttons: list[list[str]] = field(default_factory=list)
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


@dataclass
class AgentEvent:
    """A pub/sub event flowing on the events channel of the message bus.

    Agent events carry a ``topic`` (semantic label) and a ``target`` (the
    wire-level ZMQ SUB prefix).  ``target`` is what decides who receives
    the event - the broker performs no routing of its own; SUB sockets
    filter messages by prefix.  Recognised ``target`` shapes:

    - ``broadcast``             every subscriber receives it.
    - ``agent:<agent_id>``      direct delivery to a single agent.
    - ``topic:<topic>``         everyone subscribed to that topic.

    The ``topic`` field is independent of ``target`` so the producer can
    publish ``topic="cron.fired"`` as a broadcast while a specific agent
    can publish ``topic="agent.direct"`` with ``target="agent:bob"``.

    **Request/reply:** use :func:`build_request_reply_event` to acknowledge or
    respond to a direct message: ``payload`` must include the
    request's ``correlation_id`` (same value as the ``message_id`` / correlation
    field from the original ``agent.direct`` event).  If the sender used
    ``send_to_agent_wait_reply``, the direct payload also includes
    ``expects_reply: true`` so the peer knows to answer with ``agent.request.reply``.
    """

    topic: str
    payload: dict[str, Any] = field(default_factory=dict)
    source_agent: str = "system"
    target: str = TARGET_BROADCAST
    # Envelope fields - excluded from equality so tests that compare
    # AgentEvent objects do not need to pin auto-generated ids.
    message_id: str = field(default_factory=new_message_id, compare=False)
    trace_id: str = field(default_factory=new_trace_id, compare=False)
    event_seq: int = field(default=0, compare=False)
    produced_at: float = field(default_factory=produced_at, compare=False)


def build_request_reply_event(
    *,
    correlation_id: str,
    to_agent_id: str,
    content: str = "",
    source_agent: str = "system",
    error: str | None = None,
    metadata: dict[str, Any] | None = None,
    source_session_key: str | None = None,
    target_session_key: str | None = None,
) -> AgentEvent:
    """Build an ``agent.request.reply`` event for :meth:`MessageBus.request_event` matching."""
    _cid = str(correlation_id).strip()
    payload: dict[str, Any] = {
        KEY_CORRELATION_ID: _cid,
        "content": str(content) if content is not None else "",
        "sender_agent_id": str(source_agent),
    }
    if error is not None and str(error).strip():
        payload[KEY_REPLY_ERROR] = str(error)
    source_session = str(source_session_key or "").strip()
    if source_session:
        payload[KEY_SOURCE_SESSION_KEY] = source_session
    target_session = str(target_session_key or "").strip()
    if target_session:
        payload[KEY_TARGET_SESSION_KEY] = target_session
    if metadata:
        payload["metadata"] = dict(metadata)
    return AgentEvent(
        topic=TOPIC_AGENT_REQUEST_REPLY,
        payload=payload,
        source_agent=str(source_agent),
        target=target_for_agent(str(to_agent_id).strip()),
    )


def should_handle_direct_for_session(ev: AgentEvent, session_key: str | None) -> bool:
    """Return True when *ev* should be consumed by this session loop.

    Direct agent messages are consumed at agent scope (``agent:<id>`` target).
    Session hints in payload are best-effort metadata and must not block
    delivery, otherwise request/reply can deadlock after session/room rotation.
    """
    _ = session_key
    return True


def render_agent_event_for_llm(ev: AgentEvent, *, max_body_chars: int | None = None) -> str:
    """Format *ev* as system-visible text for agent loops (subscribe / team)."""
    try:
        body = json.dumps(ev.payload, ensure_ascii=False, indent=2)
    except Exception:
        body = str(ev.payload)
    if max_body_chars is not None and len(body) > max_body_chars:
        body = body[:max_body_chars] + "\n…(truncated)"
    pl = ev.payload if isinstance(ev.payload, dict) else None
    head = f"[event] topic={ev.topic} from={ev.source_agent} target={ev.target}\n"
    if ev.topic == "agent.direct" and pl and pl.get(KEY_EXPECTS_REPLY):
        cid = pl.get(KEY_CORRELATION_ID) or pl.get("message_id")
        if cid:
            sa = pl.get("sender_agent_id", "")
            to_hint = repr(sa) if sa else "sender_agent_id from the payload"
            head += (
                f"[REPLY REQUIRED] The other agent is blocked on send_to_agent_wait_reply. "
                f"You MUST call reply_to_agent_request(to_agent_id={to_hint}, "
                f"correlation_id={cid!r}, content=<answer>). "
                f"Or publish_event(topic={TOPIC_AGENT_REQUEST_REPLY!r}, target=…, "
                f"payload with {KEY_CORRELATION_ID!r}={cid!r}).\n"
            )
    return head + body
