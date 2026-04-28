"""Async message queue abstraction for channel-agent decoupling.

The in-process :class:`MessageBus` (backed by ``asyncio.Queue``) is the
only supported implementation in the consolidated single-process layout.
It is fast, zero-dependency, and preserves the original semantics that
existing unit tests rely on.
"""

from __future__ import annotations

import asyncio
import dataclasses
import time as _time
from collections import deque
from collections.abc import Iterable
from typing import Any, Protocol

from loguru import logger

from openpawlet.bus.envelope import (
    KEY_CORRELATION_ID,
    TARGET_AGENT_PREFIX,
    TOPIC_AGENT_REQUEST_REPLY,
    new_message_id,
    produced_at,
)
from openpawlet.bus.events import AgentEvent, InboundMessage, OutboundMessage

# Sliding-window length used to derive per-second rates exposed via
# :meth:`MessageBus.stats_snapshot`. 10s matches the legacy ZMQ broker.
_RATE_WINDOW_S: float = 10.0
# Maximum number of recent message samples retained in memory. The samples
# ring buffer is FIFO and resets on process restart - this layout never
# persists queue traffic to disk.
_SAMPLE_CAPACITY: int = 200


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
        agent_name: str = "",
        topics: Iterable[str] = (),
        include_broadcast: bool = True,
        maxsize: int = 0,
    ) -> EventSubscription: ...

    async def list_pending_direct_events(self, *, agent_id: str) -> list[AgentEvent]: ...

    async def ack_pending_direct_event(self, *, agent_id: str, message_id: str) -> bool: ...

    async def list_event_subscribers(
        self,
        *,
        topic: str | None = None,
    ) -> list[dict[str, object]]: ...

    async def request_event(
        self,
        request_ev: AgentEvent,
        *,
        correlation_id: str,
        timeout_s: float,
        max_retries: int,
        base_backoff_s: float,
    ) -> tuple[AgentEvent | None, int, str]: ...


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
        detach: callable[[EventSubscription], None] | None = None,
        *,
        agent_id: str,
        agent_name: str = "",
        topics: tuple[str, ...],
        include_broadcast: bool,
    ) -> None:
        self._queue = queue
        self._detach = detach
        self.agent_id = agent_id
        self.agent_name = str(agent_name or "").strip()
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

    async def __aenter__(self) -> EventSubscription:
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        self.close()

    def __aiter__(self) -> EventSubscription:
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
    from openpawlet.bus.envelope import (
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
        return any(topic_target == t or topic_target.startswith(t + ".") or t == "" for t in topics)
    # Unknown target shape: deliver only to a broadcast subscriber.
    return include_broadcast


class RequestReplyMixin:
    """In-process + ZMQ: shared :meth:`request_event` and reply fulfillment."""

    _request_waiters: dict[str, asyncio.Future[AgentEvent]]
    _request_waiters_lock: asyncio.Lock

    async def _try_fulfill_request_reply(self, ev: AgentEvent) -> bool:
        """If *ev* is a reply and matches a waiter, complete it and skip pub/sub delivery."""
        if (ev.topic or "") != TOPIC_AGENT_REQUEST_REPLY:
            return False
        payload = ev.payload or {}
        cid = str(payload.get(KEY_CORRELATION_ID) or payload.get("correlation_id") or "").strip()
        if not cid:
            return False
        async with self._request_waiters_lock:
            fut = self._request_waiters.pop(cid, None)
        if fut is None:
            return False
        if fut.done():
            return True
        try:
            fut.set_result(ev)
        except asyncio.InvalidStateError:
            pass
        return True

    async def request_event(
        self,
        request_ev: AgentEvent,
        *,
        correlation_id: str,
        timeout_s: float,
        max_retries: int,
        base_backoff_s: float,
    ) -> tuple[AgentEvent | None, int, str]:
        """Send *request_ev* and wait for :data:`TOPIC_AGENT_REQUEST_REPLY` with matching correlation.

        Retries re-publish a fresh *message_id* while keeping the same
        *correlation_id* in the payload. *max_retries* is the number of
        additional attempts after the first.
        """
        cid = str(correlation_id).strip()
        if not cid:
            return (None, 0, "error:empty_correlation_id")
        n_extra = max(0, int(max_retries))
        attempts_cap = 1 + n_extra
        for attempt in range(attempts_cap):
            fut: asyncio.Future[AgentEvent] = asyncio.get_running_loop().create_future()
            async with self._request_waiters_lock:
                self._request_waiters[cid] = fut
            if attempt == 0:
                req = request_ev
            else:
                new_mid = new_message_id()
                pl: dict[str, Any] = dict(request_ev.payload or {})
                pl["message_id"] = new_mid
                pl[KEY_CORRELATION_ID] = cid
                req = dataclasses.replace(
                    request_ev,
                    message_id=new_mid,
                    produced_at=produced_at(),
                    payload=pl,
                )
            try:
                await self.publish_event(req)
            except Exception as exc:  # pragma: no cover - bus-specific
                async with self._request_waiters_lock:
                    if self._request_waiters.get(cid) is fut:
                        self._request_waiters.pop(cid, None)
                if not fut.done():
                    try:
                        fut.set_exception(exc)
                    except (asyncio.InvalidStateError, RuntimeError):
                        pass
                return (None, attempt + 1, f"error:{exc!s}")
            try:
                reply = await asyncio.wait_for(fut, timeout=float(timeout_s))
                return (reply, attempt + 1, "ok")
            except TimeoutError:
                async with self._request_waiters_lock:
                    if self._request_waiters.get(cid) is fut:
                        self._request_waiters.pop(cid, None)
                if not fut.done():
                    fut.cancel()
            except Exception as exc:  # pragma: no cover - defensive, invalid wait state
                async with self._request_waiters_lock:
                    if self._request_waiters.get(cid) is fut:
                        self._request_waiters.pop(cid, None)
                if not fut.done():
                    try:
                        fut.set_exception(exc)
                    except (asyncio.InvalidStateError, RuntimeError):
                        pass
                return (None, attempt + 1, f"error:{exc!s}")
            if attempt >= n_extra:
                return (None, attempts_cap, "timeout")
            await asyncio.sleep(float(base_backoff_s) * (2**attempt))
        return (None, attempts_cap, "timeout")


class MessageBus(RequestReplyMixin):
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
        # Durable-ish direct mailbox for offline agents.
        # Keyed by target agent_id -> message_id -> AgentEvent.
        self._direct_mailbox: dict[str, dict[str, AgentEvent]] = {}
        self._direct_mailbox_lock = asyncio.Lock()
        self._request_waiters: dict[str, asyncio.Future[AgentEvent]] = {}
        self._request_waiters_lock = asyncio.Lock()
        # ---- in-process stats (queue-manager parity) -----------------
        # Counters are bumped from the same event loop that owns the
        # bus, so plain ints suffice (no cross-thread contention).
        self._counters: dict[str, int] = {
            "inbound_published": 0,
            "inbound_consumed": 0,
            "outbound_published": 0,
            "outbound_consumed": 0,
            "events_published": 0,
            "events_delivered": 0,
            "events_dropped_mailbox": 0,
        }
        # Sliding window of (monotonic_ts, direction) used to compute
        # per-second rates. Bounded indirectly by _RATE_WINDOW_S since
        # _trim_rate_window() drops anything older than the window.
        self._rate_window: deque[tuple[float, str]] = deque()
        # Ring buffer of recent envelopes for the Queues UI samples panel.
        # Stored as plain dicts shaped like ``QueueSampleInfo`` from the SPA.
        self._samples: deque[dict[str, Any]] = deque(maxlen=_SAMPLE_CAPACITY)
        # Pause flags are advisory display state in the in-process layout
        # (the bus never blocks). The /queues/pause route returns 409, so
        # the toggles can never flip True today; we keep the structure for
        # forward-compatibility with the existing UI/snapshot contract.
        self._paused: dict[str, bool] = {
            "inbound": False,
            "outbound": False,
            "events": False,
        }

    @staticmethod
    def _target_agent_id(ev: AgentEvent) -> str | None:
        target = (ev.target or "").strip()
        if not target.startswith(TARGET_AGENT_PREFIX):
            return None
        agent_id = target[len(TARGET_AGENT_PREFIX) :].strip()
        return agent_id or None

    async def publish_inbound(self, msg: InboundMessage) -> None:
        """Publish a message from a channel to the agent."""
        await self.inbound.put(msg)
        self._record("inbound_published", msg)

    async def consume_inbound(self) -> InboundMessage:
        """Consume the next inbound message (blocks until available)."""
        msg = await self.inbound.get()
        self._record("inbound_consumed", msg, sample=False)
        return msg

    async def publish_outbound(self, msg: OutboundMessage) -> None:
        """Publish a response from the agent to channels."""
        await self.outbound.put(msg)
        self._record("outbound_published", msg)

    async def consume_outbound(self) -> OutboundMessage:
        """Consume the next outbound message (blocks until available)."""
        msg = await self.outbound.get()
        self._record("outbound_consumed", msg, sample=False)
        return msg

    @property
    def inbound_size(self) -> int:
        """Number of pending inbound messages."""
        return self.inbound.qsize()

    @property
    def outbound_size(self) -> int:
        """Number of pending outbound messages."""
        return self.outbound.qsize()

    # ---- in-process stats (queue-manager parity) ------------------------
    @staticmethod
    def _envelope_to_sample(
        direction: str,
        msg: InboundMessage | OutboundMessage | AgentEvent,
    ) -> dict[str, Any]:
        """Project *msg* into the SPA ``QueueSampleInfo`` shape."""
        if isinstance(msg, AgentEvent):
            kind = f"event:{msg.topic or 'broadcast'}"
            session_key = ""
            try:
                payload = msg.payload or {}
                if isinstance(payload, dict):
                    raw = payload.get("session_key") or payload.get("source_session_key")
                    session_key = str(raw or "")
            except Exception:  # pragma: no cover - defensive
                session_key = ""
            text_bytes = 0
        elif isinstance(msg, InboundMessage):
            kind = f"channel:{msg.channel or 'unknown'}"
            session_key = msg.session_key
            text_bytes = len((msg.content or "").encode("utf-8", errors="replace"))
        elif isinstance(msg, OutboundMessage):
            kind = f"channel:{msg.channel or 'unknown'}"
            session_key = f"{msg.channel or 'unknown'}:{msg.chat_id or ''}"
            text_bytes = len((msg.content or "").encode("utf-8", errors="replace"))
        else:  # pragma: no cover - defensive
            kind = "unknown"
            session_key = ""
            text_bytes = 0
        return {
            "at": _time.time(),
            "direction": direction,
            "kind": kind,
            "message_id": str(getattr(msg, "message_id", "") or ""),
            "session_key": session_key,
            "bytes": int(text_bytes),
            "trace_id": str(getattr(msg, "trace_id", "") or ""),
        }

    def _trim_rate_window(self, now: float | None = None) -> None:
        """Drop rate-window samples older than ``_RATE_WINDOW_S``."""
        cutoff = (now if now is not None else _time.monotonic()) - _RATE_WINDOW_S
        window = self._rate_window
        while window and window[0][0] < cutoff:
            window.popleft()

    def _record(
        self,
        direction: str,
        msg: InboundMessage | OutboundMessage | AgentEvent,
        *,
        sample: bool = True,
    ) -> None:
        """Increment counters and optionally append a UI sample."""
        try:
            self._counters[direction] = self._counters.get(direction, 0) + 1
            now = _time.monotonic()
            self._rate_window.append((now, direction))
            self._trim_rate_window(now)
            if sample:
                self._samples.append(self._envelope_to_sample(direction, msg))
        except Exception:  # pragma: no cover - stats must never raise
            logger.debug("MessageBus stats recording failed", exc_info=True)

    def _rates(self) -> dict[str, float]:
        """Compute per-second rates from the sliding window."""
        self._trim_rate_window()
        window_s = max(_RATE_WINDOW_S, 1e-6)
        counts: dict[str, int] = {}
        for _, direction in self._rate_window:
            counts[direction] = counts.get(direction, 0) + 1
        # Expose the keys the SPA already references plus a generic mirror
        # for every counter so future widgets can pick them up.
        rates = {key: count / window_s for key, count in counts.items()}
        rates.setdefault("inbound_forwarded", rates.get("inbound_published", 0.0))
        rates.setdefault("outbound_forwarded", rates.get("outbound_published", 0.0))
        rates.setdefault("events_per_s", rates.get("events_published", 0.0))
        return rates

    def stats_snapshot(self) -> dict[str, Any]:
        """Return a structured snapshot consumed by ``queues_router``."""
        metrics: dict[str, int] = {
            "inbound_pending": self.inbound_size,
            "outbound_pending": self.outbound_size,
        }
        for key, value in self._counters.items():
            metrics[f"{key}_total"] = int(value)
        return {
            "metrics": metrics,
            "rates": self._rates(),
            "paused": dict(self._paused),
            "dedupe": {
                "enabled": False,
                "hits": 0,
                "misses": 0,
                "size": 0,
                "persist_size": 0,
            },
            "samples": self.recent_samples(),
        }

    def recent_samples(self, limit: int | None = None) -> list[dict[str, Any]]:
        """Return a copy of the most recent message samples (newest last)."""
        if limit is None or limit >= len(self._samples):
            return list(self._samples)
        if limit <= 0:
            return []
        return list(self._samples)[-limit:]

    # ---- events surface --------------------------------------------------
    async def publish_event(self, ev: AgentEvent) -> None:
        """Publish an event: fulfill a pending :meth:`request_event` or fan out."""
        if await self._try_fulfill_request_reply(ev):
            return
        await self._fan_out_event(ev)

    async def _fan_out_event(self, ev: AgentEvent) -> None:
        """Fan out *ev* to every matching local subscriber (at-most-once)."""
        # Copy under the lock so publish is concurrency-safe with
        # subscribe/unsubscribe without holding the lock across deliveries.
        async with self._event_subs_lock:
            subs = list(self._event_subs)
        delivered = False
        for sub in subs:
            if _event_matches(
                ev,
                agent_id=sub.agent_id,
                topics=sub.topics,
                include_broadcast=sub.include_broadcast,
            ):
                await sub._deliver(ev)
                delivered = True
        self._record("events_published", ev)
        if delivered:
            self._counters["events_delivered"] += 1
            self._rate_window.append((_time.monotonic(), "events_delivered"))
        # If a direct message had no active subscriber, keep it in mailbox
        # so a future subscriber can replay and ack it.
        target_agent_id = self._target_agent_id(ev)
        if target_agent_id and not delivered:
            async with self._direct_mailbox_lock:
                bucket = self._direct_mailbox.setdefault(target_agent_id, {})
                if ev.message_id not in bucket:
                    bucket[ev.message_id] = ev
            self._counters["events_dropped_mailbox"] += 1
            logger.info(
                "queued_direct_message target_agent_id={} message_id={}",
                target_agent_id,
                ev.message_id,
            )

    def subscribe_events(
        self,
        *,
        agent_id: str,
        agent_name: str = "",
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
            agent_name=agent_name,
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

    async def list_pending_direct_events(self, *, agent_id: str) -> list[AgentEvent]:
        """Return pending direct events for *agent_id* (oldest first)."""
        aid = str(agent_id).strip()
        if not aid:
            return []
        async with self._direct_mailbox_lock:
            bucket = self._direct_mailbox.get(aid, {})
            return sorted(
                bucket.values(),
                key=lambda ev: (float(getattr(ev, "produced_at", 0.0) or 0.0), ev.message_id),
            )

    async def ack_pending_direct_event(self, *, agent_id: str, message_id: str) -> bool:
        """Ack one pending direct event and delete it from mailbox."""
        aid = str(agent_id).strip()
        mid = str(message_id).strip()
        if not aid or not mid:
            return False
        async with self._direct_mailbox_lock:
            bucket = self._direct_mailbox.get(aid)
            if not bucket:
                return False
            removed = bucket.pop(mid, None)
            if not bucket:
                self._direct_mailbox.pop(aid, None)
        if removed is not None:
            logger.info(
                "acked_direct_message target_agent_id={} message_id={}",
                aid,
                mid,
            )
            return True
        return False

    async def list_event_subscribers(
        self,
        *,
        topic: str | None = None,
    ) -> list[dict[str, object]]:
        """Return active local event subscribers, optionally filtered by topic."""
        qtopic = str(topic or "").strip()
        async with self._event_subs_lock:
            subs = list(self._event_subs)
        aggregated: dict[str, dict[str, object]] = {}
        for sub in subs:
            if qtopic and not any(
                qtopic == t or qtopic.startswith(t + ".") or t == "" for t in sub.topics
            ):
                continue
            row = aggregated.setdefault(
                sub.agent_id,
                {
                    "agent_id": sub.agent_id,
                    "agent_name": "",
                    "topics": set(),
                    "include_broadcast": False,
                    "subscription_count": 0,
                },
            )
            an = str(sub.agent_name or "").strip()
            if an and not str(row.get("agent_name", "") or "").strip():
                row["agent_name"] = an
            topics_set = row["topics"]
            assert isinstance(topics_set, set)
            topics_set.update(sub.topics)
            row["include_broadcast"] = bool(row["include_broadcast"]) or bool(sub.include_broadcast)
            row["subscription_count"] = int(row["subscription_count"]) + 1
        rows: list[dict[str, object]] = []
        for aid in sorted(aggregated):
            row = aggregated[aid]
            topics_set = row["topics"]
            assert isinstance(topics_set, set)
            rows.append(
                {
                    "agent_id": aid,
                    "agent_name": str(row.get("agent_name", "") or ""),
                    "topics": sorted(str(t) for t in topics_set),
                    "include_broadcast": bool(row["include_broadcast"]),
                    "subscription_count": int(row["subscription_count"]),
                }
            )
        return rows
