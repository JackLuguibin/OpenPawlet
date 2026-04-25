"""Tests for the agent-facing event tools (publish/subscribe/send_to_agent)."""

from __future__ import annotations

import asyncio
import json

import pytest

from nanobot.agent.tools.events import (
    ListEventSubscribersTool,
    PublishEventTool,
    ReplyToAgentRequestTool,
    SendToAgentTool,
    SendToAgentWaitReplyTool,
    SubscribeEventTool,
)
from nanobot.bus.envelope import (
    KEY_CORRELATION_ID,
    KEY_EXPECTS_REPLY,
    KEY_SOURCE_SESSION_KEY,
    KEY_TARGET_SESSION_KEY,
    target_for_agent,
)
from nanobot.bus.events import (
    AgentEvent,
    InboundMessage,
    build_request_reply_event,
    render_agent_event_for_llm,
)
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
    tool.set_context("alice", "console:team_a")
    bob_sub = bus.subscribe_events(agent_id="bob")
    alice_sub = bus.subscribe_events(agent_id="alice")
    try:
        await tool.execute(agent_id="bob", content="ping")
        got = await asyncio.wait_for(bob_sub.get(), timeout=0.5)
        assert got.topic == "agent.direct"
        assert got.target == target_for_agent("bob")
        assert got.payload["content"] == "ping"
        assert got.payload["message_id"] == got.message_id
        assert got.payload["sender_agent_id"] == "alice"
        assert got.payload[KEY_SOURCE_SESSION_KEY] == "console:team_a"
        assert got.payload.get(KEY_EXPECTS_REPLY) is not True
        assert isinstance(got.payload["created_at"], float)
        # Alice is the sender and should NOT receive her own direct-to-bob event.
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(alice_sub.get(), timeout=0.2)
    finally:
        bob_sub.close()
        alice_sub.close()


@pytest.mark.asyncio
async def test_send_to_agent_wait_reply_tool_ok() -> None:
    bus = MessageBus()
    bob_sub = bus.subscribe_events(agent_id="bob")
    tool = SendToAgentWaitReplyTool(bus=bus, default_source_agent="alice")
    tool.set_context("alice", "console:sender")
    try:
        async def _bob_reply() -> None:
            ev = await asyncio.wait_for(bob_sub.get(), timeout=2.0)
            pl = ev.payload or {}
            assert pl.get(KEY_EXPECTS_REPLY) is True
            assert pl.get(KEY_CORRELATION_ID) == pl.get("message_id")
            assert pl.get(KEY_SOURCE_SESSION_KEY) == "console:sender"
            cid = pl["message_id"]
            r = build_request_reply_event(
                correlation_id=cid, to_agent_id="alice", content="ack", source_agent="bob"
            )
            await bus.publish_event(r)

        reply_task = asyncio.create_task(_bob_reply())
        raw = await tool.execute(
            agent_id="bob",
            content="hi",
            timeout_s=2,
            max_retries=0,
            base_backoff_s=0,
        )
        await reply_task
        data = json.loads(raw)
        assert data["status"] == "ok"
        assert data["reply"]["payload"]["content"] == "ack"
    finally:
        bob_sub.close()


@pytest.mark.asyncio
async def test_send_to_agent_wait_reply_self_target_uses_source_team_session() -> None:
    bus = MessageBus()
    sub = bus.subscribe_events(agent_id="alice")
    tool = SendToAgentWaitReplyTool(bus=bus, default_source_agent="alice")
    tool.set_context("alice", "console:team_t1_room_r1_agent_alice")
    try:
        async def _reply() -> None:
            ev = await asyncio.wait_for(sub.get(), timeout=2.0)
            pl = ev.payload or {}
            # Wrong non-team target_session_key should be normalized to source team session.
            assert pl.get(KEY_TARGET_SESSION_KEY) == "console:team_t1_room_r1_agent_alice"
            cid = pl["message_id"]
            await bus.publish_event(
                build_request_reply_event(
                    correlation_id=cid,
                    to_agent_id="alice",
                    content="ack",
                    source_agent="alice",
                )
            )

        reply_task = asyncio.create_task(_reply())
        raw = await tool.execute(
            agent_id="alice",
            content="hi",
            target_session_key="console:websocket-chat",
            timeout_s=2,
            max_retries=0,
            base_backoff_s=0,
        )
        await reply_task
        data = json.loads(raw)
        assert data["status"] == "ok"
    finally:
        sub.close()


@pytest.mark.asyncio
async def test_reply_to_agent_request_tool_ends_send_to_agent_wait_reply() -> None:
    bus = MessageBus()
    bob_sub = bus.subscribe_events(agent_id="bob")
    wait_tool = SendToAgentWaitReplyTool(bus=bus, default_source_agent="alice")
    wait_tool.set_context("alice", "console:caller")
    reply_tool = ReplyToAgentRequestTool(bus=bus, default_source_agent="bob")
    reply_tool.set_context("bob", "console:callee")
    try:
        async def _bob_reply() -> None:
            ev = await asyncio.wait_for(bob_sub.get(), timeout=2.0)
            pl = ev.payload or {}
            out = await reply_tool.execute(
                to_agent_id=pl["sender_agent_id"],
                correlation_id=pl[KEY_CORRELATION_ID],
                content="ack via tool",
            )
            assert "Reply published" in out

        reply_task = asyncio.create_task(_bob_reply())
        raw = await wait_tool.execute(
            agent_id="bob",
            content="hi",
            timeout_s=2,
            max_retries=0,
            base_backoff_s=0,
        )
        await reply_task
        data = json.loads(raw)
        assert data["status"] == "ok"
        assert data["reply"]["payload"]["content"] == "ack via tool"
        assert data["reply"]["payload"][KEY_SOURCE_SESSION_KEY] == "console:callee"
    finally:
        bob_sub.close()


@pytest.mark.asyncio
async def test_reply_to_agent_request_rejects_empty_content_without_error() -> None:
    bus = MessageBus()
    tool = ReplyToAgentRequestTool(bus=bus, default_source_agent="bob")
    out = await tool.execute(
        to_agent_id="alice",
        correlation_id="m-1",
        content="   ",
    )
    assert out.startswith("Error:")


@pytest.mark.asyncio
async def test_reply_to_agent_request_allows_error_without_content() -> None:
    bus = MessageBus()
    tool = ReplyToAgentRequestTool(bus=bus, default_source_agent="bob")
    out = await tool.execute(
        to_agent_id="alice",
        correlation_id="m-1",
        content="",
        error="failed",
    )
    assert "Reply published" in out


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


@pytest.mark.asyncio
async def test_subscribe_event_background_replays_pending_direct() -> None:
    bus = MessageBus()
    send_tool = SendToAgentTool(bus=bus, default_source_agent="alice")
    received: list[InboundMessage] = []

    async def _inject(msg: InboundMessage) -> None:
        received.append(msg)

    sub_tool = SubscribeEventTool(
        bus=bus,
        default_agent_id="bob",
        inject_inbound=_inject,
    )
    sub_tool.set_context(
        agent_id="bob",
        session_key="cli:direct",
        channel="cli",
        chat_id="direct",
    )

    await send_tool.execute(agent_id="bob", content="offline ping")
    out = await sub_tool.execute(topics=[])
    assert "Subscribed in background" in out

    for _ in range(20):
        if received:
            break
        await asyncio.sleep(0.02)
    sub_tool.cancel_all_background_subscriptions()
    await asyncio.sleep(0.05)

    assert received, "pending direct event should be replayed via injector"
    assert "offline ping" in received[0].content
    pending = await bus.list_pending_direct_events(agent_id="bob")
    assert pending == []


@pytest.mark.asyncio
async def test_subscribe_event_inline_await_ignores_target_session_hint() -> None:
    bus = MessageBus()
    send_tool = SendToAgentTool(bus=bus, default_source_agent="alice")
    await send_tool.execute(
        agent_id="bob",
        content="for a specific session",
        target_session_key="console:team_t1_room_r1_agent_bob",
    )

    any_session_tool = SubscribeEventTool(bus=bus, default_agent_id="bob")
    any_session_tool.set_context(agent_id="bob", session_key="console:another")
    out = await any_session_tool.execute(topics=[], timeout_s=1)
    data = json.loads(out)
    assert data["topic"] == "agent.direct"
    assert data["payload"][KEY_TARGET_SESSION_KEY] == "console:team_t1_room_r1_agent_bob"
    pending_after = await bus.list_pending_direct_events(agent_id="bob")
    assert pending_after == []


@pytest.mark.asyncio
async def test_list_event_subscribers_tool_can_discover_agents() -> None:
    bus = MessageBus()
    alice = bus.subscribe_events(
        agent_id="alice", agent_name="Alice", topics=("team",), include_broadcast=False
    )
    bob = bus.subscribe_events(agent_id="bob", topics=("team.chat",), include_broadcast=True)
    tool = ListEventSubscribersTool(bus=bus)
    try:
        raw = await tool.execute(topic="team.chat.new")
        data = json.loads(raw)
        assert data["count"] == 2
        rows = {item["agent_id"]: item for item in data["subscribers"]}
        assert set(rows) == {"alice", "bob"}
        assert rows["alice"]["topics"] == ["team"]
        assert rows["alice"]["agent_name"] == "Alice"
        assert rows["alice"]["include_broadcast"] is False
        assert rows["bob"]["topics"] == ["team.chat"]
        assert rows["bob"]["agent_name"] == ""
        assert rows["bob"]["include_broadcast"] is True
    finally:
        alice.close()
        bob.close()


def test_render_agent_event_for_llm_inserts_reply_banner() -> None:
    ev = AgentEvent(
        topic="agent.direct",
        payload={
            "content": "hi",
            "message_id": "m-test",
            KEY_CORRELATION_ID: "m-test",
            KEY_EXPECTS_REPLY: True,
        },
        source_agent="alice",
        target=target_for_agent("bob"),
    )
    text = render_agent_event_for_llm(ev)
    assert "[REPLY REQUIRED]" in text
    assert "m-test" in text
    assert "reply_to_agent_request" in text
