"""Async message queue abstraction for channel-agent decoupling.

The in-process :class:`MessageBus` (backed by ``asyncio.Queue``) stays as
the default; it is fast, zero-dependency, and preserves the original
semantics that existing unit tests rely on.  The ZeroMQ-backed bus lives
next to it (:class:`ZmqMessageBus`) so any call site that already talks
to ``publish_inbound`` / ``consume_outbound`` / ``outbound.get_nowait``
can be switched transparently at wiring time.
"""

from __future__ import annotations

import asyncio
from typing import Protocol

from nanobot.bus.events import InboundMessage, OutboundMessage


class MessageBusProtocol(Protocol):
    """Duck-typed contract every bus implementation must satisfy."""

    inbound: asyncio.Queue[InboundMessage]
    outbound: asyncio.Queue[OutboundMessage]

    async def publish_inbound(self, msg: InboundMessage) -> None: ...
    async def consume_inbound(self) -> InboundMessage: ...
    async def publish_outbound(self, msg: OutboundMessage) -> None: ...
    async def consume_outbound(self) -> OutboundMessage: ...

    @property
    def inbound_size(self) -> int: ...

    @property
    def outbound_size(self) -> int: ...


class MessageBus:
    """
    Async message bus that decouples chat channels from the agent core.

    Channels push messages to the inbound queue, and the agent processes
    them and pushes responses to the outbound queue.
    """

    def __init__(self):
        self.inbound: asyncio.Queue[InboundMessage] = asyncio.Queue()
        self.outbound: asyncio.Queue[OutboundMessage] = asyncio.Queue()

    async def publish_inbound(self, msg: InboundMessage) -> None:
        """Publish a message from a channel to the agent."""
        await self.inbound.put(msg)

    async def consume_inbound(self) -> InboundMessage:
        """Consume the next inbound message (blocks until available)."""
        return await self.inbound.get()

    async def publish_outbound(self, msg: OutboundMessage) -> None:
        """Publish a response from the agent to channels."""
        await self.outbound.put(msg)

    async def consume_outbound(self) -> OutboundMessage:
        """Consume the next outbound message (blocks until available)."""
        return await self.outbound.get()

    @property
    def inbound_size(self) -> int:
        """Number of pending inbound messages."""
        return self.inbound.qsize()

    @property
    def outbound_size(self) -> int:
        """Number of pending outbound messages."""
        return self.outbound.qsize()
