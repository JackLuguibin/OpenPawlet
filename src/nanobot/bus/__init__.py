"""Message bus module for decoupled channel-agent communication."""

from nanobot.bus.events import AgentEvent, InboundMessage, OutboundMessage
from nanobot.bus.factory import build_message_bus
from nanobot.bus.queue import EventSubscription, MessageBus, MessageBusProtocol
from nanobot.bus.zmq_bus import ZmqBusEndpoints, ZmqMessageBus

__all__ = [
    "AgentEvent",
    "EventSubscription",
    "InboundMessage",
    "MessageBus",
    "MessageBusProtocol",
    "OutboundMessage",
    "ZmqBusEndpoints",
    "ZmqMessageBus",
    "build_message_bus",
]
