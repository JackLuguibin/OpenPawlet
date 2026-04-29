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
from openpawlet.bus.stats_models import (
    BusDedupeStats,
    BusPausedFlags,
    MessageBusStatsSnapshot,
    QueueModeBlock,
    QueuesGoneBody,
    QueuesHealthResponse,
    QueuesHttpSnapshot,
    QueuesStreamTick,
)

__all__ = [
    "AgentEvent",
    "BusDedupeStats",
    "BusPausedFlags",
    "MessageBusStatsSnapshot",
    "QueueModeBlock",
    "QueuesGoneBody",
    "QueuesHealthResponse",
    "QueuesHttpSnapshot",
    "QueuesStreamTick",
    "EventSubscription",
    "InboundMessage",
    "MessageBus",
    "MessageBusProtocol",
    "OutboundMessage",
    "RequestReplyMixin",
    "build_message_bus",
    "build_request_reply_event",
]
