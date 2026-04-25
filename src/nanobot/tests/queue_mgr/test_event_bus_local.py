"""Tests for the in-process event pub/sub on :class:`MessageBus`."""

from __future__ import annotations

import asyncio

import pytest

from nanobot.bus.envelope import (
    KEY_CORRELATION_ID,
    TARGET_BROADCAST,
    TOPIC_AGENT_REQUEST_REPLY,
    target_for_agent,
    target_for_topic,
)
from nanobot.bus.events import AgentEvent, build_request_reply_event
from nanobot.bus.queue import MessageBus


@pytest.mark.asyncio
async def test_broadcast_reaches_every_subscriber() -> None:
    bus = MessageBus()
    alice = bus.subscribe_events(agent_id="alice")
    bob = bus.subscribe_events(agent_id="bob")
    try:
        await bus.publish_event(
            AgentEvent(topic="hello", payload={"msg": "hi"}, source_agent="system")
        )
        a = await asyncio.wait_for(alice.get(), timeout=0.5)
        b = await asyncio.wait_for(bob.get(), timeout=0.5)
        assert a.topic == b.topic == "hello"
        assert a.target == TARGET_BROADCAST
    finally:
        alice.close()
        bob.close()


@pytest.mark.asyncio
async def test_direct_message_targets_only_named_agent() -> None:
    bus = MessageBus()
    alice = bus.subscribe_events(agent_id="alice")
    bob = bus.subscribe_events(agent_id="bob")
    try:
        await bus.publish_event(
            AgentEvent(
                topic="agent.direct",
                payload={"content": "ping"},
                source_agent="external",
                target=target_for_agent("bob"),
            )
        )
        got = await asyncio.wait_for(bob.get(), timeout=0.5)
        assert got.payload == {"content": "ping"}
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(alice.get(), timeout=0.2)
    finally:
        alice.close()
        bob.close()


@pytest.mark.asyncio
async def test_topic_subscription_prefix_match() -> None:
    bus = MessageBus()
    watcher = bus.subscribe_events(
        agent_id="watcher",
        topics=("inventory",),
        include_broadcast=False,
    )
    other = bus.subscribe_events(
        agent_id="other",
        topics=("chat",),
        include_broadcast=False,
    )
    try:
        await bus.publish_event(
            AgentEvent(
                topic="inventory.updated",
                payload={"sku": "a"},
                source_agent="system",
                target=target_for_topic("inventory.updated"),
            )
        )
        got = await asyncio.wait_for(watcher.get(), timeout=0.5)
        assert got.topic == "inventory.updated"
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(other.get(), timeout=0.2)
    finally:
        watcher.close()
        other.close()


@pytest.mark.asyncio
async def test_close_unsubscribes() -> None:
    bus = MessageBus()
    sub = bus.subscribe_events(agent_id="alice")
    sub.close()
    await bus.publish_event(
        AgentEvent(topic="hello", payload={}, source_agent="system")
    )
    # Detached subscription has no queue receivers; nothing to assert here
    # other than that publish does not raise when there are zero listeners.
    assert sub.size() == 0


@pytest.mark.asyncio
async def test_direct_message_queued_when_target_offline_then_acked() -> None:
    bus = MessageBus()
    ev = AgentEvent(
        topic="agent.direct",
        payload={"content": "hello"},
        source_agent="alice",
        target=target_for_agent("bob"),
    )
    await bus.publish_event(ev)

    pending = await bus.list_pending_direct_events(agent_id="bob")
    assert [item.message_id for item in pending] == [ev.message_id]

    ok = await bus.ack_pending_direct_event(agent_id="bob", message_id=ev.message_id)
    assert ok is True
    assert await bus.list_pending_direct_events(agent_id="bob") == []


@pytest.mark.asyncio
async def test_request_event_receives_correlated_reply() -> None:
    bus = MessageBus()
    sub_bob = bus.subscribe_events(agent_id="bob")
    try:
        cid = "m-corr-1"
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

        task = asyncio.create_task(
            bus.request_event(
                req,
                correlation_id=cid,
                timeout_s=0.5,
                max_retries=0,
                base_backoff_s=0,
            )
        )
        ev_in = await asyncio.wait_for(sub_bob.get(), timeout=1.0)
        pl = ev_in.payload or {}
        reply = build_request_reply_event(
            correlation_id=str(pl.get(KEY_CORRELATION_ID) or pl.get("message_id")),
            to_agent_id="alice",
            content="pong",
            source_agent="bob",
        )
        await bus.publish_event(reply)
        got, attempts, status = await task
        assert status == "ok"
        assert attempts == 1
        assert got is not None
        assert (got.payload or {}).get("content") == "pong"
    finally:
        sub_bob.close()


@pytest.mark.asyncio
async def test_request_event_timeout_with_retry_then_ok() -> None:
    bus = MessageBus()
    sub_bob = bus.subscribe_events(agent_id="bob")
    try:
        cid = "m-corr-2"
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
        t0 = asyncio.get_running_loop().time()

        async def _responder() -> None:
            await sub_bob.get()
            # Fires during the 3rd per-attempt wait (0.1–0.15s) after two 0.05s timeouts.
            await asyncio.sleep(0.12)
            r = build_request_reply_event(
                correlation_id=cid, to_agent_id="alice", content="late", source_agent="bob"
            )
            await bus.publish_event(r)

        asyncio.create_task(_responder())
        got, attempts, status = await bus.request_event(
            req,
            correlation_id=cid,
            timeout_s=0.05,
            max_retries=2,
            base_backoff_s=0,
        )
        assert status == "ok"
        assert attempts == 3
        assert (got.payload or {}).get("content") == "late"
        assert asyncio.get_running_loop().time() - t0 >= 0.05
    finally:
        sub_bob.close()


@pytest.mark.asyncio
async def test_late_reply_not_fulfilling_after_timeout_does_not_crash() -> None:
    bus = MessageBus()
    sub_bob = bus.subscribe_events(agent_id="bob")
    try:
        cid = "m-corr-3"
        req = AgentEvent(
            topic="agent.direct",
            payload={
                "content": "x",
                "message_id": cid,
                KEY_CORRELATION_ID: cid,
                "sender_agent_id": "alice",
                "created_at": 0.0,
            },
            source_agent="alice",
            target=target_for_agent("bob"),
            message_id=cid,
        )
        task = asyncio.create_task(
            bus.request_event(
                req,
                correlation_id=cid,
                timeout_s=0.05,
                max_retries=0,
                base_backoff_s=0,
            )
        )
        ev_in = await asyncio.wait_for(sub_bob.get(), timeout=0.5)
        assert ev_in
        out = await task
        assert out[1] == 1
        assert out[2] == "timeout"
        r = build_request_reply_event(
            correlation_id=cid, to_agent_id="alice", content="late", source_agent="bob"
        )
        sub_alice = bus.subscribe_events(agent_id="alice")
        try:
            await bus.publish_event(r)
            got = await asyncio.wait_for(sub_alice.get(), timeout=0.5)
            assert got.topic == TOPIC_AGENT_REQUEST_REPLY
        finally:
            sub_alice.close()
    finally:
        sub_bob.close()
