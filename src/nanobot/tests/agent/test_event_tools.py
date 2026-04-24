"""Tests for the agent-facing event tools (publish/subscribe/send_to_agent)."""

from __future__ import annotations

import asyncio
import json

import pytest

from nanobot.agent.tools.events import (
    PublishEventTool,
    SendToAgentTool,
    SubscribeEventTool,
)
from nanobot.bus.envelope import target_for_agent
from nanobot.bus.events import AgentEvent, InboundMessage
from nanobot.bus.queue import MessageBus


@pytest.mark.asyncio
async def test_publish_event_tool_routes_to_bus() -> None:
    bus = MessageBus()
    tool = PublishEventTool(bus=bus, default_source_agent="alice")
    sub = bus.subscribe_events(agent_id="bob")
    try:
        result = await tool.execute(
            topic="inventory.updated",
            payload={"sku": "a"},
        )
        assert "Event published" in result
        ev = await asyncio.wait_for(sub.get(), timeout=0.5)
        assert ev.topic == "inventory.updated"
        assert ev.source_agent == "alice"
        assert ev.payload == {"sku": "a"}
    finally:
        sub.close()


@pytest.mark.asyncio
async def test_send_to_agent_tool_uses_agent_target() -> None:
    bus = MessageBus()
    tool = SendToAgentTool(bus=bus, default_source_agent="alice")
    bob_sub = bus.subscribe_events(agent_id="bob")
    alice_sub = bus.subscribe_events(agent_id="alice")
    try:
        await tool.execute(agent_id="bob", content="ping")
        got = await asyncio.wait_for(bob_sub.get(), timeout=0.5)
        assert got.topic == "agent.direct"
        assert got.target == target_for_agent("bob")
        assert got.payload["content"] == "ping"
        # Alice is the sender and should NOT receive her own direct-to-bob event.
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(alice_sub.get(), timeout=0.2)
    finally:
        bob_sub.close()
        alice_sub.close()


@pytest.mark.asyncio
async def test_subscribe_event_inline_await_returns_next_event() -> None:
    bus = MessageBus()
    tool = SubscribeEventTool(bus=bus, default_agent_id="alice")

    async def _publish_later() -> None:
        await asyncio.sleep(0.05)
        await bus.publish_event(
            AgentEvent(topic="notify.me", payload={"k": 1}, source_agent="system")
        )

    asyncio.create_task(_publish_later())
    result = await tool.execute(topics=[], timeout_s=1)
    data = json.loads(result)
    assert data["topic"] == "notify.me"
    assert data["payload"] == {"k": 1}


@pytest.mark.asyncio
async def test_subscribe_event_inline_await_timeout() -> None:
    bus = MessageBus()
    tool = SubscribeEventTool(bus=bus, default_agent_id="alice")
    result = await tool.execute(topics=[], timeout_s=1)
    assert result.startswith("timeout")


@pytest.mark.asyncio
async def test_subscribe_event_background_injects_inbound_message() -> None:
    bus = MessageBus()
    received: list[InboundMessage] = []

    async def _inject(msg: InboundMessage) -> None:
        received.append(msg)

    tool = SubscribeEventTool(
        bus=bus,
        default_agent_id="alice",
        inject_inbound=_inject,
    )
    tool.set_context(
        agent_id="alice", session_key="cli:direct", channel="cli", chat_id="direct"
    )
    result = await tool.execute(topics=["chat"])
    assert "Subscribed in background" in result

    await bus.publish_event(
        AgentEvent(
            topic="chat.new",
            payload={"body": "hi"},
            source_agent="system",
            target="topic:chat.new",
        )
    )
    # Give the pump a turn to deliver.
    for _ in range(20):
        if received:
            break
        await asyncio.sleep(0.02)

    tool.cancel_all_background_subscriptions()
    # Give the event loop a tick so the cancelled tasks finish tearing
    # down (avoids 'coroutine never awaited' warnings in pytest).
    await asyncio.sleep(0.05)

    assert received, "background subscription should inject an InboundMessage"
    msg = received[0]
    assert msg.channel == "system"
    assert msg.sender_id.startswith("event:")
    assert msg.session_key_override == "cli:direct"
    assert msg.metadata.get("event_topic") == "chat.new"
