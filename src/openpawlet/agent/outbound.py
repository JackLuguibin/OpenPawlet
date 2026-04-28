"""Helpers that build :class:`OutboundMessage` payloads from an inbound turn.

The agent loop publishes many outbound messages per turn (stream deltas,
stream-end markers, retry waits, error fallbacks).  Each call site previously
duplicated the ``dict(msg.metadata or {})`` + channel/chat copy boilerplate.
This module owns that pattern so the loop reads as a sequence of intents
rather than a wall of dataclass constructors.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from openpawlet.bus.events import OutboundMessage

if TYPE_CHECKING:
    from openpawlet.bus.events import InboundMessage


def reply_to(
    msg: InboundMessage,
    content: str = "",
    *,
    extra_metadata: dict[str, Any] | None = None,
) -> OutboundMessage:
    """Build an :class:`OutboundMessage` that replies to ``msg``.

    The result inherits ``channel`` / ``chat_id`` and merges any extra
    metadata onto a defensive copy of ``msg.metadata`` so callers never
    accidentally mutate the inbound dict.
    """
    metadata: dict[str, Any] = dict(msg.metadata or {})
    if extra_metadata:
        metadata.update(extra_metadata)
    return OutboundMessage(
        channel=msg.channel,
        chat_id=msg.chat_id,
        content=content,
        metadata=metadata,
    )


__all__ = ["reply_to"]
