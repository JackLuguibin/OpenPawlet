"""Message bus module for decoupled channel-agent communication."""

from openpawlet.bus.events import (
    AgentEvent,
    InboundMessage,
    OutboundMessage,
    build_request_reply_event,
)
from openpawlet.bus.factory import build_message_bus
from openpawlet.bus.queue import (
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
