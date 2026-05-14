"""Wire-level constants for envelope fields shared across producers (Console / agents).

Keeps stable JSON field names for idempotency and tracing."""

from __future__ import annotations

import secrets
import time
import uuid

# Stable wire names — do not rename without a coordinated migration.
KEY_MESSAGE_ID = "message_id"
KEY_DEDUPE_KEY = "dedupe_key"
KEY_TRACE_ID = "trace_id"

# Event-channel addressing (matches ZMQ SUB prefix filtering when brokered).
TARGET_BROADCAST = "broadcast"
TARGET_AGENT_PREFIX = "agent:"
TARGET_TOPIC_PREFIX = "topic:"

TOPIC_AGENT_REQUEST_REPLY = "agent.request.reply"
KEY_CORRELATION_ID = "correlation_id"
KEY_REPLY_ERROR = "error"
KEY_TARGET_SESSION_KEY = "target_session_key"
KEY_SOURCE_SESSION_KEY = "source_session_key"
KEY_EXPECTS_REPLY = "expects_reply"


def target_for_agent(agent_id: str) -> str:
    """Return the subscription prefix string for addressing *agent_id* directly."""
    return f"{TARGET_AGENT_PREFIX}{agent_id}"


def new_message_id() -> str:
    """Return a new globally unique message id."""
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
    """Default dedupe bucket when the producer does not override ``dedupe_key``."""
    return f"{channel}:{chat_id}:{message_id}"
