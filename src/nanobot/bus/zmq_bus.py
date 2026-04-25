"""ZeroMQ-backed :class:`MessageBus` drop-in replacement.

Architecture
------------
The unified queue manager runs a central broker exposing four sockets:

- ``ingress`` (PULL):  producers push ``InboundMessage`` envelopes.
- ``worker``  (PUB):   broker fan-outs ``InboundMessage`` envelopes to
  every connected agent/worker that subscribes.
- ``egress``  (PULL):  workers push ``OutboundMessage`` envelopes.
- ``delivery``(PUB):   broker fan-outs ``OutboundMessage`` envelopes to
  every connected channel dispatcher.

:class:`ZmqMessageBus` hides the four sockets behind the same interface
as :class:`nanobot.bus.queue.MessageBus` so the agent loop and channel
manager work unchanged.  Internally we keep the two ``asyncio.Queue``
instances (``inbound`` / ``outbound``) because several consumers rely
on ``get_nowait`` semantics (see the delta coalescing path in
:mod:`nanobot.channels.manager`); background pump tasks copy frames
between the ZeroMQ sockets and the in-process queues.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from loguru import logger

from nanobot.bus.envelope import (
    ENVELOPE_VERSION,
    KEY_ATTEMPT,
    KEY_DEDUPE_KEY,
    KEY_EVENT_SEQ,
    KEY_KIND,
    KEY_MESSAGE_ID,
    KEY_PAYLOAD,
    KEY_PRODUCED_AT,
    KEY_SESSION_KEY,
    KEY_SOURCE_AGENT,
    KEY_TARGET,
    KEY_TOPIC,
    KEY_TRACE_ID,
    KEY_VERSION,
    KIND_EVENT,
    KIND_INBOUND,
    KIND_OUTBOUND,
    TARGET_AGENT_PREFIX,
    TARGET_BROADCAST,
    TARGET_TOPIC_PREFIX,
    produced_at,
    target_for_agent,
    target_for_topic,
)
from nanobot.bus.events import AgentEvent, InboundMessage, OutboundMessage
from nanobot.bus.queue import EventSubscription, RequestReplyMixin, _event_matches


def _encode_inbound(msg: InboundMessage) -> bytes:
    """Serialize an :class:`InboundMessage` into the wire envelope."""
    envelope: dict[str, Any] = {
        KEY_VERSION: ENVELOPE_VERSION,
        KEY_KIND: KIND_INBOUND,
        KEY_MESSAGE_ID: msg.message_id,
        KEY_DEDUPE_KEY: msg.dedupe_key,
        KEY_EVENT_SEQ: msg.event_seq,
        KEY_TRACE_ID: msg.trace_id,
        KEY_SESSION_KEY: msg.session_key,
        KEY_ATTEMPT: msg.attempt,
        KEY_PRODUCED_AT: produced_at(),
        KEY_PAYLOAD: {
            "channel": msg.channel,
            "sender_id": msg.sender_id,
            "chat_id": msg.chat_id,
            "content": msg.content,
            "timestamp": msg.timestamp.isoformat(),
            "media": list(msg.media),
            "metadata": dict(msg.metadata),
            "session_key_override": msg.session_key_override,
        },
    }
    return json.dumps(envelope, ensure_ascii=False).encode("utf-8")


def _encode_outbound(msg: OutboundMessage) -> bytes:
    envelope: dict[str, Any] = {
        KEY_VERSION: ENVELOPE_VERSION,
        KEY_KIND: KIND_OUTBOUND,
        KEY_MESSAGE_ID: msg.message_id,
        KEY_DEDUPE_KEY: msg.dedupe_key,
        KEY_EVENT_SEQ: msg.event_seq,
        KEY_TRACE_ID: msg.trace_id,
        KEY_SESSION_KEY: f"{msg.channel}:{msg.chat_id}",
        KEY_ATTEMPT: msg.attempt,
        KEY_PRODUCED_AT: produced_at(),
        KEY_PAYLOAD: {
            "channel": msg.channel,
            "chat_id": msg.chat_id,
            "content": msg.content,
            "reply_to": msg.reply_to,
            "media": list(msg.media),
            "metadata": dict(msg.metadata),
        },
    }
    return json.dumps(envelope, ensure_ascii=False).encode("utf-8")


def _decode_inbound(data: bytes) -> InboundMessage:
    raw = json.loads(data.decode("utf-8"))
    payload = raw.get(KEY_PAYLOAD, {})
    from datetime import datetime

    timestamp_raw = payload.get("timestamp")
    try:
        ts = datetime.fromisoformat(timestamp_raw) if timestamp_raw else datetime.now()
    except ValueError:
        ts = datetime.now()
    return InboundMessage(
        channel=payload.get("channel", ""),
        sender_id=payload.get("sender_id", ""),
        chat_id=payload.get("chat_id", ""),
        content=payload.get("content", ""),
        timestamp=ts,
        media=list(payload.get("media", [])),
        metadata=dict(payload.get("metadata", {})),
        session_key_override=payload.get("session_key_override"),
        message_id=raw.get(KEY_MESSAGE_ID, ""),
        dedupe_key=raw.get(KEY_DEDUPE_KEY),
        event_seq=int(raw.get(KEY_EVENT_SEQ, 0) or 0),
        trace_id=raw.get(KEY_TRACE_ID, ""),
        attempt=int(raw.get(KEY_ATTEMPT, 0) or 0),
    )


def _decode_outbound(data: bytes) -> OutboundMessage:
    raw = json.loads(data.decode("utf-8"))
    payload = raw.get(KEY_PAYLOAD, {})
    return OutboundMessage(
        channel=payload.get("channel", ""),
        chat_id=payload.get("chat_id", ""),
        content=payload.get("content", ""),
        reply_to=payload.get("reply_to"),
        media=list(payload.get("media", [])),
        metadata=dict(payload.get("metadata", {})),
        message_id=raw.get(KEY_MESSAGE_ID, ""),
        dedupe_key=raw.get(KEY_DEDUPE_KEY),
        event_seq=int(raw.get(KEY_EVENT_SEQ, 0) or 0),
        trace_id=raw.get(KEY_TRACE_ID, ""),
        attempt=int(raw.get(KEY_ATTEMPT, 0) or 0),
    )


def _encode_event(ev: AgentEvent) -> bytes:
    """Serialise an :class:`AgentEvent` into the wire envelope.

    The frame is always JSON-encoded; the broker wraps it in a
    multipart ZMQ message ``[target, envelope_json]`` so SUB sockets
    can filter by prefix without parsing the payload.
    """
    envelope: dict[str, Any] = {
        KEY_VERSION: ENVELOPE_VERSION,
        KEY_KIND: KIND_EVENT,
        KEY_MESSAGE_ID: ev.message_id,
        KEY_TRACE_ID: ev.trace_id,
        KEY_EVENT_SEQ: ev.event_seq,
        KEY_PRODUCED_AT: ev.produced_at or produced_at(),
        KEY_TOPIC: ev.topic,
        KEY_SOURCE_AGENT: ev.source_agent,
        KEY_TARGET: ev.target or TARGET_BROADCAST,
        KEY_PAYLOAD: dict(ev.payload),
    }
    return json.dumps(envelope, ensure_ascii=False).encode("utf-8")


def _decode_event(data: bytes) -> AgentEvent:
    raw = json.loads(data.decode("utf-8"))
    return AgentEvent(
        topic=str(raw.get(KEY_TOPIC, "")),
        payload=dict(raw.get(KEY_PAYLOAD, {}) or {}),
        source_agent=str(raw.get(KEY_SOURCE_AGENT, "system")),
        target=str(raw.get(KEY_TARGET, TARGET_BROADCAST) or TARGET_BROADCAST),
        message_id=str(raw.get(KEY_MESSAGE_ID, "") or ""),
        trace_id=str(raw.get(KEY_TRACE_ID, "") or ""),
        event_seq=int(raw.get(KEY_EVENT_SEQ, 0) or 0),
        produced_at=float(raw.get(KEY_PRODUCED_AT, 0.0) or 0.0),
    )


def event_zmq_subscriptions(
    *,
    agent_id: str,
    topics: "list[str] | tuple[str, ...]" = (),
    include_broadcast: bool = True,
) -> list[str]:
    """Return the ZMQ SUB prefixes required for the given subscription params.

    Exposed as a helper so the subscribe_events implementation and tests
    stay in lock-step with the broker's multipart frame layout.
    """
    prefixes: list[str] = [target_for_agent(agent_id)]
    if include_broadcast:
        prefixes.append(TARGET_BROADCAST)
    for t in topics:
        prefixes.append(target_for_topic(t))
    return prefixes


class ZmqBusEndpoints:
    """Collection of ZeroMQ endpoints shared by producers and consumers.

    The events channel is optional for backward compatibility - when
    both ``events_ingress`` and ``events_delivery`` are empty the bus
    silently disables the events path.
    """

    def __init__(
        self,
        *,
        ingress: str,
        worker: str,
        egress: str,
        delivery: str,
        events_ingress: str = "",
        events_delivery: str = "",
    ) -> None:
        self.ingress = ingress
        self.worker = worker
        self.egress = egress
        self.delivery = delivery
        self.events_ingress = events_ingress
        self.events_delivery = events_delivery

    @classmethod
    def default_tcp(
        cls,
        host: str = "127.0.0.1",
        base_port: int = 7180,
    ) -> ZmqBusEndpoints:
        """Return a default set of endpoints for the given host / base port."""
        return cls(
            ingress=f"tcp://{host}:{base_port}",
            worker=f"tcp://{host}:{base_port + 1}",
            egress=f"tcp://{host}:{base_port + 2}",
            delivery=f"tcp://{host}:{base_port + 3}",
            events_ingress=f"tcp://{host}:{base_port + 4}",
            events_delivery=f"tcp://{host}:{base_port + 5}",
        )

    @property
    def has_events(self) -> bool:
        return bool(self.events_ingress and self.events_delivery)


class ZmqMessageBus(RequestReplyMixin):
    """ZeroMQ-backed bus with the :class:`MessageBus` surface.

    The class is role-aware: producers/consumers only connect the
    sockets they need, so a channel can be inbound-only without opening
    the delivery subscriber.
    """

    def __init__(
        self,
        endpoints: ZmqBusEndpoints,
        *,
        role: str = "full",  # full | producer | agent | dispatcher
        subscription: str = "",
        buffer_maxsize: int = 0,
        agent_id: str = "",
        agent_name: str = "",
    ) -> None:
        try:
            import zmq  # type: ignore
            import zmq.asyncio  # type: ignore
        except ImportError as exc:  # pragma: no cover - exercised in install checks
            raise RuntimeError(
                "pyzmq is required for ZmqMessageBus. "
                "Install it with `pip install pyzmq`."
            ) from exc
        self._zmq = zmq
        self._endpoints = endpoints
        self._role = role
        self._subscription = subscription
        self._agent_id = agent_id
        self._agent_name = str(agent_name or "").strip()

        # Own Context per bus so multiple buses in different event
        # loops (integration tests, multiple workers) do not share an
        # internal IO thread.
        self._context = zmq.asyncio.Context()
        self._ingress_sock: Any | None = None  # PUSH to broker
        self._worker_sock: Any | None = None  # SUB from broker
        self._egress_sock: Any | None = None  # PUSH to broker
        self._delivery_sock: Any | None = None  # SUB from broker
        self._events_push_sock: Any | None = None  # PUSH to broker (events ingress)
        self._events_sub_sock: Any | None = None  # SUB from broker (events delivery)

        # Mirror queues keep the synchronous `outbound.get_nowait()` contract
        # that `ChannelManager._coalesce_stream_deltas` depends on.
        self.inbound: asyncio.Queue[InboundMessage] = asyncio.Queue(maxsize=buffer_maxsize)
        self.outbound: asyncio.Queue[OutboundMessage] = asyncio.Queue(maxsize=buffer_maxsize)

        # Active SUB prefixes on the events socket, plus the set of
        # local subscriptions that will receive fan-outs from the pump.
        self._event_sub_prefixes: set[str] = set()
        self._event_subs: list[EventSubscription] = []
        self._event_subs_lock = asyncio.Lock()
        # Local mailbox fallback for direct events when no local subscriber
        # is active. This preserves offline delivery for in-process users
        # of this bus instance.
        self._direct_mailbox: dict[str, dict[str, AgentEvent]] = {}
        self._direct_mailbox_lock = asyncio.Lock()
        self._request_waiters: dict[str, asyncio.Future[AgentEvent]] = {}
        self._request_waiters_lock = asyncio.Lock()

        self._pump_tasks: list[asyncio.Task[None]] = []
        self._started = False

    # ---- lifecycle ------------------------------------------------------
    async def start(self) -> None:
        """Connect the sockets this role needs and spawn pump tasks."""
        if self._started:
            return
        zmq = self._zmq
        if self._role in {"full", "producer"}:
            self._ingress_sock = self._context.socket(zmq.PUSH)
            self._ingress_sock.connect(self._endpoints.ingress)
        if self._role in {"full", "agent"}:
            self._worker_sock = self._context.socket(zmq.SUB)
            self._worker_sock.connect(self._endpoints.worker)
            self._worker_sock.setsockopt_string(zmq.SUBSCRIBE, self._subscription)
            self._pump_tasks.append(
                asyncio.create_task(self._pump_inbound(), name="zmq-pump-inbound")
            )
        if self._role in {"full", "agent"}:
            self._egress_sock = self._context.socket(zmq.PUSH)
            self._egress_sock.connect(self._endpoints.egress)
        if self._role in {"full", "dispatcher"}:
            self._delivery_sock = self._context.socket(zmq.SUB)
            self._delivery_sock.connect(self._endpoints.delivery)
            self._delivery_sock.setsockopt_string(zmq.SUBSCRIBE, self._subscription)
            self._pump_tasks.append(
                asyncio.create_task(self._pump_outbound(), name="zmq-pump-outbound")
            )
        # Connect the events sockets for any role that wants to talk
        # pub/sub (producer & agent on ingress; agent & dispatcher on
        # delivery).  Roles without events participation simply skip it.
        if self._endpoints.has_events:
            if self._role in {"full", "producer", "agent"}:
                self._events_push_sock = self._context.socket(zmq.PUSH)
                self._events_push_sock.connect(self._endpoints.events_ingress)
            if self._role in {"full", "agent", "dispatcher"}:
                self._events_sub_sock = self._context.socket(zmq.SUB)
                self._events_sub_sock.connect(self._endpoints.events_delivery)
                # Subscribe to this agent's direct inbox + broadcast by
                # default.  Topic subscriptions are added dynamically via
                # subscribe_events().
                default_prefixes: set[str] = {TARGET_BROADCAST}
                if self._agent_id:
                    default_prefixes.add(target_for_agent(self._agent_id))
                for prefix in default_prefixes:
                    self._events_sub_sock.setsockopt_string(zmq.SUBSCRIBE, prefix)
                    self._event_sub_prefixes.add(prefix)
                self._pump_tasks.append(
                    asyncio.create_task(self._pump_events(), name="zmq-pump-events")
                )
        self._started = True
        logger.info(
            "ZmqMessageBus started (role={}, agent_id={}, agent_name={}, ingress={}, worker={}, "
            "egress={}, delivery={}, events_ingress={}, events_delivery={})",
            self._role,
            self._agent_id or "-",
            self._agent_name or "-",
            self._endpoints.ingress,
            self._endpoints.worker,
            self._endpoints.egress,
            self._endpoints.delivery,
            self._endpoints.events_ingress or "-",
            self._endpoints.events_delivery or "-",
        )

    async def stop(self) -> None:
        """Cancel pump tasks and close sockets."""
        for task in self._pump_tasks:
            task.cancel()
        for task in self._pump_tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        self._pump_tasks.clear()
        for sock in (
            self._ingress_sock,
            self._worker_sock,
            self._egress_sock,
            self._delivery_sock,
            self._events_push_sock,
            self._events_sub_sock,
        ):
            if sock is not None:
                try:
                    sock.close(linger=0)
                except Exception:  # pragma: no cover - best effort on shutdown
                    pass
        self._ingress_sock = None
        self._worker_sock = None
        self._egress_sock = None
        self._delivery_sock = None
        self._events_push_sock = None
        self._events_sub_sock = None
        self._event_sub_prefixes.clear()
        self._event_subs.clear()
        self._started = False
        try:
            self._context.term()
        except Exception:  # pragma: no cover - best effort
            pass

    # ---- MessageBus API -------------------------------------------------
    async def publish_inbound(self, msg: InboundMessage) -> None:
        if not self._started:
            await self.start()
        if self._ingress_sock is None:
            raise RuntimeError("ZmqMessageBus role cannot publish inbound")
        await self._ingress_sock.send(_encode_inbound(msg))

    async def consume_inbound(self) -> InboundMessage:
        if not self._started:
            await self.start()
        return await self.inbound.get()

    async def publish_outbound(self, msg: OutboundMessage) -> None:
        if not self._started:
            await self.start()
        if self._egress_sock is None:
            raise RuntimeError("ZmqMessageBus role cannot publish outbound")
        await self._egress_sock.send(_encode_outbound(msg))

    async def consume_outbound(self) -> OutboundMessage:
        if not self._started:
            await self.start()
        return await self.outbound.get()

    @property
    def inbound_size(self) -> int:
        return self.inbound.qsize()

    @property
    def outbound_size(self) -> int:
        return self.outbound.qsize()

    # ---- events ---------------------------------------------------------
    async def publish_event(self, ev: AgentEvent) -> None:
        """PUSH an :class:`AgentEvent` to the broker's events ingress."""
        if not self._started:
            await self.start()
        if self._events_push_sock is None:
            raise RuntimeError(
                "ZmqMessageBus role/endpoints cannot publish events "
                "(events_ingress missing)"
            )
        target = (ev.target or TARGET_BROADCAST).encode("utf-8")
        await self._events_push_sock.send_multipart([target, _encode_event(ev)])

    def subscribe_events(
        self,
        *,
        agent_id: str,
        agent_name: str = "",
        topics: "list[str] | tuple[str, ...]" = (),
        include_broadcast: bool = True,
        maxsize: int = 0,
    ) -> EventSubscription:
        """Register a new local event subscription.

        The returned :class:`EventSubscription` receives events that
        match its filter.  The call also makes sure the underlying SUB
        socket is subscribed to the right ZMQ prefixes so the broker
        actually forwards the frames to us.
        """
        if self._events_sub_sock is None:
            raise RuntimeError(
                "ZmqMessageBus role/endpoints cannot receive events "
                "(events_delivery missing)"
            )
        zmq = self._zmq
        requested = event_zmq_subscriptions(
            agent_id=agent_id,
            topics=tuple(topics),
            include_broadcast=include_broadcast,
        )
        for prefix in requested:
            if prefix not in self._event_sub_prefixes:
                self._events_sub_sock.setsockopt_string(zmq.SUBSCRIBE, prefix)
                self._event_sub_prefixes.add(prefix)
        queue: asyncio.Queue[AgentEvent] = asyncio.Queue(maxsize=maxsize)
        aid = (agent_id or "").strip()
        an = str(agent_name or "").strip()
        if not an and aid and aid == (self._agent_id or "").strip():
            an = self._agent_name
        sub = EventSubscription(
            queue,
            detach=self._detach_subscription,
            agent_id=agent_id,
            agent_name=an,
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
        """Return active subscribers visible to this bus process."""
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
            row["include_broadcast"] = bool(row["include_broadcast"]) or bool(
                sub.include_broadcast
            )
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

    # ---- pumps ----------------------------------------------------------
    async def _pump_inbound(self) -> None:
        assert self._worker_sock is not None
        try:
            while True:
                data = await self._worker_sock.recv()
                try:
                    msg = _decode_inbound(data)
                except Exception as exc:
                    logger.warning("ZmqMessageBus: dropped malformed inbound: {}", exc)
                    continue
                await self.inbound.put(msg)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - surfaced only on socket errors
            logger.exception("ZmqMessageBus inbound pump crashed: {}", exc)

    async def _pump_outbound(self) -> None:
        assert self._delivery_sock is not None
        try:
            while True:
                data = await self._delivery_sock.recv()
                try:
                    msg = _decode_outbound(data)
                except Exception as exc:
                    logger.warning("ZmqMessageBus: dropped malformed outbound: {}", exc)
                    continue
                await self.outbound.put(msg)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover
            logger.exception("ZmqMessageBus outbound pump crashed: {}", exc)

    async def _pump_events(self) -> None:
        """Fan out broker-delivered events to every matching local subscription."""
        assert self._events_sub_sock is not None
        try:
            while True:
                frames = await self._events_sub_sock.recv_multipart()
                # Broker layout: [target, envelope_json].  Fall back to a
                # single-frame format for safety during migrations.
                if len(frames) >= 2:
                    payload = frames[1]
                else:
                    payload = frames[0]
                try:
                    ev = _decode_event(payload)
                except Exception as exc:
                    logger.warning("ZmqMessageBus: dropped malformed event: {}", exc)
                    continue
                if await self._try_fulfill_request_reply(ev):
                    continue
                # Copy under the lock but fan out outside of it to avoid
                # blocking new subscribers while we deliver.
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
                target = (ev.target or "").strip()
                if target.startswith(TARGET_AGENT_PREFIX) and not delivered:
                    aid = target[len(TARGET_AGENT_PREFIX) :].strip()
                    if aid:
                        async with self._direct_mailbox_lock:
                            bucket = self._direct_mailbox.setdefault(aid, {})
                            if ev.message_id not in bucket:
                                bucket[ev.message_id] = ev
                        logger.info(
                            "queued_direct_message target_agent_id={} message_id={}",
                            aid,
                            ev.message_id,
                        )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover
            logger.exception("ZmqMessageBus events pump crashed: {}", exc)
