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
    KEY_TRACE_ID,
    KEY_VERSION,
    KIND_INBOUND,
    KIND_OUTBOUND,
    produced_at,
)
from nanobot.bus.events import InboundMessage, OutboundMessage


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


class ZmqBusEndpoints:
    """Collection of ZeroMQ endpoints shared by producers and consumers."""

    def __init__(
        self,
        *,
        ingress: str,
        worker: str,
        egress: str,
        delivery: str,
    ) -> None:
        self.ingress = ingress
        self.worker = worker
        self.egress = egress
        self.delivery = delivery

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
        )


class ZmqMessageBus:
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

        # Own Context per bus so multiple buses in different event
        # loops (integration tests, multiple workers) do not share an
        # internal IO thread.
        self._context = zmq.asyncio.Context()
        self._ingress_sock: Any | None = None  # PUSH to broker
        self._worker_sock: Any | None = None  # SUB from broker
        self._egress_sock: Any | None = None  # PUSH to broker
        self._delivery_sock: Any | None = None  # SUB from broker

        # Mirror queues keep the synchronous `outbound.get_nowait()` contract
        # that `ChannelManager._coalesce_stream_deltas` depends on.
        self.inbound: asyncio.Queue[InboundMessage] = asyncio.Queue(maxsize=buffer_maxsize)
        self.outbound: asyncio.Queue[OutboundMessage] = asyncio.Queue(maxsize=buffer_maxsize)

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
        self._started = True
        logger.info(
            "ZmqMessageBus started (role={}, ingress={}, worker={}, egress={}, delivery={})",
            self._role,
            self._endpoints.ingress,
            self._endpoints.worker,
            self._endpoints.egress,
            self._endpoints.delivery,
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
