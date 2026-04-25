"""Unified message envelope definitions for the ZeroMQ-backed queue.

This module centralises the cross-process wire contract used by all the
Queue Manager participants (Console, Nanobot gateway, Queue Manager broker,
Cron/Heartbeat producers).  Keeping the envelope in one place lets us
evolve the idempotency guarantees without touching every call site.

Business-level "exactly once" semantics are expressed via three fields:

- ``message_id``     Globally unique identifier for one logical event.  When
                    the same ``message_id`` is seen twice, consumers MUST
                    treat the second occurrence as a duplicate.
- ``dedupe_key``     Coarser key for grouping events that share a side
                    effect (for example ``(channel, chat_id, turn_id)``).
                    Used by the idempotency store when the broker replays.
- ``event_seq``      Monotonic sequence number attached by the producer
                    within a single logical stream (for example chat
                    delta order).  The broker guarantees delivery, the
                    ``event_seq`` lets consumers detect and drop out of
                    order / duplicate segments.

The constants below are shared between Python producers (Console,
Nanobot) and the Queue Manager broker so that a rename here is enough
to migrate the whole system.
"""

from __future__ import annotations

import secrets
import time
import uuid

# ZeroMQ topic prefixes - one topic per logical channel so subscribers
# can filter at the wire level instead of deserialising every frame.
TOPIC_INBOUND = "inbound"
TOPIC_OUTBOUND = "outbound"
TOPIC_CONTROL = "control"
TOPIC_EVENT = "event"

# Envelope keys (stable wire names - do not rename without a migration).
ENVELOPE_VERSION = 1
KEY_VERSION = "v"
KEY_MESSAGE_ID = "message_id"
KEY_DEDUPE_KEY = "dedupe_key"
KEY_EVENT_SEQ = "event_seq"
KEY_SESSION_KEY = "session_key"
KEY_TRACE_ID = "trace_id"
KEY_CHANNEL = "channel"
KEY_PRODUCED_AT = "produced_at"
KEY_ATTEMPT = "attempt"
KEY_KIND = "kind"  # "inbound" / "outbound" / "event"
KEY_PAYLOAD = "payload"

# Event-specific envelope keys.  An agent event extends the same
# envelope shape as InboundMessage/OutboundMessage, with three extra
# top-level fields that identify the pub/sub coordinates.
KEY_TOPIC = "topic"
KEY_SOURCE_AGENT = "source_agent"
KEY_TARGET = "target"

# Kinds - whether the enveloped payload is an InboundMessage, an
# OutboundMessage, or an AgentEvent.  Kept string so it survives JSON
# round-trips.
KIND_INBOUND = "inbound"
KIND_OUTBOUND = "outbound"
KIND_EVENT = "event"

# Target prefixes used on the events channel.  SUB sockets subscribe to
# these prefixes so the broker does not have to inspect the payload.
TARGET_BROADCAST = "broadcast"
TARGET_AGENT_PREFIX = "agent:"
TARGET_TOPIC_PREFIX = "topic:"

# Request/reply on the events channel (see :func:`build_request_reply_event`).
# Reply events use ``topic=TOPIC_AGENT_REQUEST_REPLY`` and
# ``payload[KEY_CORRELATION_ID]`` to match a pending :meth:`MessageBus.request_event`.
TOPIC_AGENT_REQUEST_REPLY = "agent.request.reply"
KEY_CORRELATION_ID = "correlation_id"
KEY_REPLY_ERROR = "error"
KEY_TARGET_SESSION_KEY = "target_session_key"
KEY_SOURCE_SESSION_KEY = "source_session_key"
# Set to True on ``agent.direct`` from the ``send_to_agent_wait_reply`` tool so
# the receiver knows a matching ``agent.request.reply`` is required.
KEY_EXPECTS_REPLY = "expects_reply"


def target_for_agent(agent_id: str) -> str:
    """Return the ZMQ SUB prefix string for addressing *agent_id* directly."""
    return f"{TARGET_AGENT_PREFIX}{agent_id}"


def target_for_topic(topic: str) -> str:
    """Return the ZMQ SUB prefix string for subscribing to *topic*."""
    return f"{TARGET_TOPIC_PREFIX}{topic}"


def new_message_id() -> str:
    """Return a new globally unique message id."""
    # UUID4 gives us 122 bits of entropy; a short random prefix makes logs
    # easier to eyeball without loss of uniqueness.
    return f"m-{uuid.uuid4().hex}"


def new_trace_id() -> str:
    """Return a new trace id used to correlate logs across services."""
    return f"t-{secrets.token_hex(8)}"


def produced_at() -> float:
    """Return the current produced-at timestamp (seconds since epoch)."""
    return time.time()


def build_dedupe_key(
    *,
    channel: str,
    chat_id: str,
    message_id: str,
) -> str:
    """Return the default idempotency key used when the producer does not set one.

    The default scheme guarantees that retrying the same logical event on
    the same chat routes to the same idempotency bucket, which is what
    the broker needs to discard replays.
    """
    return f"{channel}:{chat_id}:{message_id}"
