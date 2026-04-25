"""End-to-end test of the events pub/sub channel through the real broker."""

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


@pytest.mark.asyncio
async def test_broadcast_event_roundtrip_through_broker() -> None:
    from nanobot.bus.envelope import target_for_agent
    from nanobot.bus.events import AgentEvent
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
    )
    broker = QueueManagerBroker(settings)
    await broker.start()

    endpoints = ZmqBusEndpoints(
        ingress=settings.ingress_endpoint(),
        worker=settings.worker_endpoint(),
        egress=settings.egress_endpoint(),
        delivery=settings.delivery_endpoint(),
        events_ingress=settings.events_ingress_endpoint(),
        events_delivery=settings.events_delivery_endpoint(),
    )
    producer = ZmqMessageBus(endpoints, role="producer", agent_id="prod")
    alice = ZmqMessageBus(endpoints, role="agent", agent_id="alice")
    bob = ZmqMessageBus(endpoints, role="agent", agent_id="bob")

    try:
        await producer.start()
        await alice.start()
        await bob.start()
        await asyncio.sleep(0.25)  # let SUB sockets subscribe

        sub_alice = alice.subscribe_events(agent_id="alice")
        sub_bob = bob.subscribe_events(agent_id="bob")
        await asyncio.sleep(0.1)

        ev = AgentEvent(topic="chat.new", payload={"x": 1}, source_agent="prod")
        await producer.publish_event(ev)

        got_a = await asyncio.wait_for(sub_alice.get(), timeout=2.0)
        got_b = await asyncio.wait_for(sub_bob.get(), timeout=2.0)
        assert got_a.topic == "chat.new"
        assert got_b.message_id == ev.message_id

        # Duplicate publish of the same message_id is dropped by broker dedupe.
        await producer.publish_event(ev)
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(sub_alice.get(), timeout=0.4)

        # Direct-to-bob event does not reach alice.
        direct = AgentEvent(
            topic="agent.direct",
            payload={"content": "hi bob"},
            source_agent="prod",
            target=target_for_agent("bob"),
        )
        await producer.publish_event(direct)
        got_direct = await asyncio.wait_for(sub_bob.get(), timeout=2.0)
        assert got_direct.payload == {"content": "hi bob"}
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(sub_alice.get(), timeout=0.4)

        # Broker counters reflect the two forwarded events + one duplicate.
        metrics = broker.metrics()
        assert metrics["events_forwarded"] >= 2
        assert metrics["events_dropped_duplicate"] >= 1

        sub_alice.close()
        sub_bob.close()
    finally:
        await alice.stop()
        await bob.stop()
        await producer.stop()
        await broker.stop()


@pytest.mark.asyncio
async def test_request_reply_event_roundtrip_through_broker() -> None:
    from nanobot.bus.envelope import KEY_CORRELATION_ID, target_for_agent
    from nanobot.bus.events import AgentEvent, build_request_reply_event
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
    )
    broker = QueueManagerBroker(settings)
    await broker.start()

    endpoints = ZmqBusEndpoints(
        ingress=settings.ingress_endpoint(),
        worker=settings.worker_endpoint(),
        egress=settings.egress_endpoint(),
        delivery=settings.delivery_endpoint(),
        events_ingress=settings.events_ingress_endpoint(),
        events_delivery=settings.events_delivery_endpoint(),
    )
    alice = ZmqMessageBus(endpoints, role="agent", agent_id="alice")
    bob = ZmqMessageBus(endpoints, role="agent", agent_id="bob")

    try:
        await alice.start()
        await bob.start()
        await asyncio.sleep(0.3)

        sub_bob = bob.subscribe_events(agent_id="bob")
        cid = "m-broker-rr-1"
        req = AgentEvent(
            topic="agent.direct",
            payload={
                "content": "ping",
                "message_id": cid,
                KEY_CORRELATION_ID: cid,
                "sender_agent_id": "alice",
                "created_at": 0.0,
            },
            source_agent="alice",
            target=target_for_agent("bob"),
            message_id=cid,
        )
        wait = asyncio.create_task(
            alice.request_event(
                req,
                correlation_id=cid,
                timeout_s=3.0,
                max_retries=0,
                base_backoff_s=0,
            )
        )
        ev_in = await asyncio.wait_for(sub_bob.get(), timeout=3.0)
        pl = ev_in.payload or {}
        r = build_request_reply_event(
            correlation_id=str(
                pl.get(KEY_CORRELATION_ID) or pl.get("message_id")
            ),
            to_agent_id="alice",
            content="pong",
            source_agent="bob",
        )
        await bob.publish_event(r)
        got, attempts, status = await wait
        assert status == "ok"
        assert attempts == 1
        assert (got.payload or {}).get("content") == "pong"
        sub_bob.close()
    finally:
        await alice.stop()
        await bob.stop()
        await broker.stop()
