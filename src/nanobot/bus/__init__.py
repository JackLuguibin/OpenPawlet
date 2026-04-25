"""Message bus module for decoupled channel-agent communication."""

from nanobot.bus.events import (
    AgentEvent,
    InboundMessage,
    OutboundMessage,
    build_request_reply_event,
)
from nanobot.bus.factory import build_message_bus
from nanobot.bus.queue import (
    EventSubscription,
    MessageBus,
    MessageBusProtocol,
    RequestReplyMixin,
)

__all__ = [
    "AgentEvent",
    "EventSubscription",
    "InboundMessage",
    "MessageBus",
    "MessageBusProtocol",
    "OutboundMessage",
    "RequestReplyMixin",
    "build_message_bus",
    "build_request_reply_event",
]
