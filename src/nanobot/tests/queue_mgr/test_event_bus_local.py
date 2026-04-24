"""Tests for the in-process event pub/sub on :class:`MessageBus`."""

from __future__ import annotations

import asyncio

import pytest

from nanobot.bus.envelope import (
    TARGET_BROADCAST,
    target_for_agent,
    target_for_topic,
)
from nanobot.bus.events import AgentEvent
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
