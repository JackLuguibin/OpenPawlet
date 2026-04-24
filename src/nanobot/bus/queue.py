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
from collections.abc import Iterable
from typing import Protocol

from nanobot.bus.events import AgentEvent, InboundMessage, OutboundMessage


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

    # ---- events surface ----
    async def publish_event(self, ev: AgentEvent) -> None: ...

    def subscribe_events(
        self,
        *,
        agent_id: str,
        topics: Iterable[str] = (),
        include_broadcast: bool = True,
        maxsize: int = 0,
    ) -> "EventSubscription": ...


class EventSubscription:
    """A handle to an active event subscription.

    Implementations must be usable as async context managers (``async
    with bus.subscribe_events(...) as sub:``) so resources are released
    deterministically even when the consumer bails out.  The object is
    also async-iterable for ergonomics.
    """

    def __init__(
        self,
        queue: asyncio.Queue[AgentEvent],
        detach: "callable[[EventSubscription], None] | None" = None,
        *,
        agent_id: str,
        topics: tuple[str, ...],
        include_broadcast: bool,
    ) -> None:
        self._queue = queue
        self._detach = detach
        self.agent_id = agent_id
        self.topics = topics
        self.include_broadcast = include_broadcast
        self._closed = False

    async def get(self, timeout: float | None = None) -> AgentEvent:
        """Return the next event, optionally bounded by *timeout* seconds."""
        if timeout is None:
            return await self._queue.get()
        return await asyncio.wait_for(self._queue.get(), timeout=timeout)

    def get_nowait(self) -> AgentEvent:
        return self._queue.get_nowait()

    def size(self) -> int:
        return self._queue.qsize()

    async def _deliver(self, ev: AgentEvent) -> None:
        """Internal: enqueue *ev* on this subscription (lossless for local subs)."""
        if self._closed:
            return
        try:
            self._queue.put_nowait(ev)
        except asyncio.QueueFull:
            # at-most-once semantics: drop on overflow to protect the producer.
            pass

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._detach is not None:
            try:
                self._detach(self)
            except Exception:  # pragma: no cover - defensive, detach is best-effort
                pass

    async def __aenter__(self) -> "EventSubscription":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        self.close()

    def __aiter__(self) -> "EventSubscription":
        return self

    async def __anext__(self) -> AgentEvent:
        if self._closed:
            raise StopAsyncIteration
        return await self._queue.get()


def _event_matches(
    ev: AgentEvent,
    *,
    agent_id: str,
    topics: tuple[str, ...],
    include_broadcast: bool,
) -> bool:
    """Decide whether *ev* should be delivered to a subscriber."""
    from nanobot.bus.envelope import (
        TARGET_AGENT_PREFIX,
        TARGET_BROADCAST,
        TARGET_TOPIC_PREFIX,
    )

    target = ev.target or TARGET_BROADCAST
    if target == TARGET_BROADCAST:
        return include_broadcast
    if target.startswith(TARGET_AGENT_PREFIX):
        return target[len(TARGET_AGENT_PREFIX) :] == agent_id
    if target.startswith(TARGET_TOPIC_PREFIX):
        topic_target = target[len(TARGET_TOPIC_PREFIX) :]
        if not topics:
            return False
        # Prefix match so subscribers can listen to "chat" and receive
        # events targeted at "chat.new" / "chat.updated" etc.
        return any(
            topic_target == t or topic_target.startswith(t + ".") or t == ""
            for t in topics
        )
    # Unknown target shape: deliver only to a broadcast subscriber.
    return include_broadcast


class MessageBus:
    """
    Async message bus that decouples chat channels from the agent core.

    Channels push messages to the inbound queue, and the agent processes
    them and pushes responses to the outbound queue.
    """

    def __init__(self):
        self.inbound: asyncio.Queue[InboundMessage] = asyncio.Queue()
        self.outbound: asyncio.Queue[OutboundMessage] = asyncio.Queue()
        self._event_subs: list[EventSubscription] = []
        self._event_subs_lock = asyncio.Lock()

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

    # ---- events surface --------------------------------------------------
    async def publish_event(self, ev: AgentEvent) -> None:
        """Fan out *ev* to every matching local subscriber (at-most-once)."""
        # Copy under the lock so publish is concurrency-safe with
        # subscribe/unsubscribe without holding the lock across deliveries.
        async with self._event_subs_lock:
            subs = list(self._event_subs)
        for sub in subs:
            if _event_matches(
                ev,
                agent_id=sub.agent_id,
                topics=sub.topics,
                include_broadcast=sub.include_broadcast,
            ):
                await sub._deliver(ev)

    def subscribe_events(
        self,
        *,
        agent_id: str,
        topics: Iterable[str] = (),
        include_broadcast: bool = True,
        maxsize: int = 0,
    ) -> EventSubscription:
        """Register a new local subscription.  Remember to ``close()`` it."""
        queue: asyncio.Queue[AgentEvent] = asyncio.Queue(maxsize=maxsize)
        sub = EventSubscription(
            queue,
            detach=self._detach_subscription,
            agent_id=agent_id,
            topics=tuple(topics),
            include_broadcast=include_broadcast,
        )
        self._event_subs.append(sub)
        return sub

    def _detach_subscription(self, sub: EventSubscription) -> None:
        try:
            self._event_subs.remove(sub)
        except ValueError:
            pass
