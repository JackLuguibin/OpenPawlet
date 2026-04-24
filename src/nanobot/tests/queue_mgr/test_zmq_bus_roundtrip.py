"""End-to-end test of the ZmqMessageBus + QueueManagerBroker pair.

Spins up a real broker on ephemeral ports and verifies:

1. Inbound envelopes round-trip from producer → broker → agent worker.
2. Outbound envelopes round-trip from agent worker → broker → dispatcher.
3. Duplicate ``message_id`` values are dropped by the broker.
"""

from __future__ import annotations

import asyncio
import socket
import sys

import pytest

try:
    import zmq  # type: ignore  # noqa: F401

    HAS_ZMQ = True
except Exception:  # pragma: no cover - skipped when pyzmq missing
    HAS_ZMQ = False

pytestmark = [
    pytest.mark.skipif(not HAS_ZMQ, reason="pyzmq not installed"),
    pytest.mark.skipif(
        sys.platform == "win32", reason="ZeroMQ TCP shutdown flaky on Windows CI"
    ),
]


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


async def _wait_for_queue(q: asyncio.Queue, timeout: float = 3.0):
    return await asyncio.wait_for(q.get(), timeout=timeout)


@pytest.mark.asyncio
async def test_inbound_outbound_roundtrip_through_broker() -> None:
    from nanobot.bus.events import InboundMessage, OutboundMessage
    from nanobot.bus.zmq_bus import ZmqBusEndpoints, ZmqMessageBus
    from queue_manager.config import QueueManagerSettings
    from queue_manager.service import QueueManagerBroker

    ports = [_free_port() for _ in range(6)]
    settings = QueueManagerSettings(
        host="127.0.0.1",
        ingress_port=ports[0],
        worker_port=ports[1],
        egress_port=ports[2],
        delivery_port=ports[3],
        events_ingress_port=ports[4],
        events_delivery_port=ports[5],
        health_port=0,
        idempotency_window_seconds=60,
        idempotency_max_entries=1024,
    )
    broker = QueueManagerBroker(settings)
    await broker.start()

    endpoints = ZmqBusEndpoints(
        ingress=settings.ingress_endpoint(),
        worker=settings.worker_endpoint(),
        egress=settings.egress_endpoint(),
        delivery=settings.delivery_endpoint(),
    )
    producer = ZmqMessageBus(endpoints, role="producer")
    agent = ZmqMessageBus(endpoints, role="agent")
    dispatcher = ZmqMessageBus(endpoints, role="dispatcher")

    try:
        await producer.start()
        await agent.start()
        await dispatcher.start()
        # Allow ZeroMQ PUB/SUB subscriptions to propagate before we send.
        await asyncio.sleep(0.25)

        inbound = InboundMessage(
            channel="websocket",
            sender_id="u1",
            chat_id="c1",
            content="hello",
        )
        await producer.publish_inbound(inbound)

        got_inbound = await _wait_for_queue(agent.inbound)
        assert got_inbound.content == "hello"
        assert got_inbound.message_id == inbound.message_id

        outbound = OutboundMessage(channel="websocket", chat_id="c1", content="hi!")
        await agent.publish_outbound(outbound)

        got_outbound = await _wait_for_queue(dispatcher.outbound)
        assert got_outbound.content == "hi!"
        assert got_outbound.message_id == outbound.message_id

        # Duplicate inbound must be dropped by the broker.
        await producer.publish_inbound(inbound)
        with pytest.raises(asyncio.TimeoutError):
            await _wait_for_queue(agent.inbound, timeout=0.5)

        stats = broker.metrics()
        assert stats["inbound_dropped_duplicate"] >= 1
        assert stats["inbound_forwarded"] >= 1
        assert stats["outbound_forwarded"] >= 1
    finally:
        await producer.stop()
        await agent.stop()
        await dispatcher.stop()
        await broker.stop()


@pytest.mark.asyncio
async def test_full_role_bus_publishes_and_consumes_locally() -> None:
    """A role=full bus exposes both produce and consume surfaces."""
    from nanobot.bus.events import InboundMessage
    from nanobot.bus.zmq_bus import ZmqBusEndpoints, ZmqMessageBus
    from queue_manager.config import QueueManagerSettings
    from queue_manager.service import QueueManagerBroker

    ports = [_free_port() for _ in range(6)]
    settings = QueueManagerSettings(
        host="127.0.0.1",
        ingress_port=ports[0],
        worker_port=ports[1],
        egress_port=ports[2],
        delivery_port=ports[3],
        events_ingress_port=ports[4],
        events_delivery_port=ports[5],
        health_port=0,
    )
    broker = QueueManagerBroker(settings)
    await broker.start()
    endpoints = ZmqBusEndpoints(
        ingress=settings.ingress_endpoint(),
        worker=settings.worker_endpoint(),
        egress=settings.egress_endpoint(),
        delivery=settings.delivery_endpoint(),
    )
    bus = ZmqMessageBus(endpoints, role="full")
    try:
        await bus.start()
        await asyncio.sleep(0.25)
        await bus.publish_inbound(
            InboundMessage(channel="ws", sender_id="u", chat_id="c", content="ping")
        )
        got = await _wait_for_queue(bus.inbound, timeout=2.0)
        assert got.content == "ping"
    finally:
        await bus.stop()
        await broker.stop()
