"""Message bus module for decoupled channel-agent communication."""

from nanobot.bus.events import InboundMessage, OutboundMessage
from nanobot.bus.factory import build_message_bus
from nanobot.bus.queue import MessageBus, MessageBusProtocol
from nanobot.bus.zmq_bus import ZmqBusEndpoints, ZmqMessageBus

__all__ = [
    "InboundMessage",
    "MessageBus",
    "MessageBusProtocol",
    "OutboundMessage",
    "ZmqBusEndpoints",
    "ZmqMessageBus",
    "build_message_bus",
]
