"""Tests for agent-to-agent messaging over the event bus.

These tests exercise the tool-level contract rather than booting a real
LLM provider.  They ensure that a "main" agent and a "sub" agent can
exchange direct messages through :class:`SendToAgentTool` +
:class:`SubscribeEventTool`, and that :class:`SendToAgentWaitReplyTool`
plus :class:`ReplyToAgentRequestTool` form a closed loop on the same
:class:`MessageBus`.
"""

from __future__ import annotations

import asyncio
import json
from json import JSONDecoder

import pytest

from nanobot.agent.tools.events import (
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
)
from nanobot.bus.events import InboundMessage
from nanobot.bus.queue import MessageBus


@pytest.mark.asyncio
async def test_main_and_sub_agents_can_direct_message_each_other() -> None:
    bus = MessageBus()
    main_id = "main:host:1"
    sub_id = "sub:task-abc"

    main_inbox: list[InboundMessage] = []
    sub_inbox: list[InboundMessage] = []

    async def _main_inject(msg: InboundMessage) -> None:
        main_inbox.append(msg)

    async def _sub_inject(msg: InboundMessage) -> None:
        sub_inbox.append(msg)

    main_send = SendToAgentTool(bus=bus, default_source_agent=main_id)
    main_send.set_context(main_id, "test:main")
    sub_send = SendToAgentTool(bus=bus, default_source_agent=sub_id)
    sub_send.set_context(sub_id, "test:sub")
    main_sub_tool = SubscribeEventTool(
        bus=bus, default_agent_id=main_id, inject_inbound=_main_inject
    )
    main_sub_tool.set_context(agent_id=main_id, session_key="test:1")
    sub_sub_tool = SubscribeEventTool(bus=bus, default_agent_id=sub_id, inject_inbound=_sub_inject)
    sub_sub_tool.set_context(agent_id=sub_id, session_key="test:1")

    # Both agents install background subscriptions so direct messages
    # arrive as InboundMessage injections.
    await main_sub_tool.execute(topics=[])
    await sub_sub_tool.execute(topics=[])

    try:
        # Main agent sends a task request to the sub agent.
        await main_send.execute(agent_id=sub_id, content="please summarise foo")
        # Sub agent replies to the main agent.
        await sub_send.execute(agent_id=main_id, content="summary: foo is foo")

        for _ in range(30):
            if main_inbox and sub_inbox:
                break
            await asyncio.sleep(0.02)

        assert sub_inbox, "sub agent should receive the main agent's request"
        assert main_inbox, "main agent should receive the sub agent's reply"

        assert sub_inbox[0].metadata["event_topic"] == "agent.direct"
        assert main_inbox[0].metadata["event_topic"] == "agent.direct"
        assert sub_inbox[0].metadata["event_source_agent"] == main_id
        assert main_inbox[0].metadata["event_source_agent"] == sub_id
        sub_payload = _payload_from_injected_event_text(sub_inbox[0].content)
        main_payload = _payload_from_injected_event_text(main_inbox[0].content)
        assert sub_payload[KEY_SOURCE_SESSION_KEY] == "test:main"
        assert main_payload[KEY_SOURCE_SESSION_KEY] == "test:sub"
    finally:
        main_sub_tool.cancel_all_background_subscriptions()
        sub_sub_tool.cancel_all_background_subscriptions()
        await asyncio.sleep(0.05)


def _payload_from_injected_event_text(content: str) -> dict:
    """Parse the JSON object from :func:`render_agent_event_for_llm` output."""
    idx = content.index("{")
    payload, _ = JSONDecoder().raw_decode(content, idx)
    assert isinstance(payload, dict)
    return payload


@pytest.mark.asyncio
async def test_send_to_agent_wait_reply_closed_loop_bus_subscription() -> None:
    """Alice waits; Bob receives ``agent.direct`` on the bus and ends the wait with ``reply_to_agent_request``."""
    bus = MessageBus()
    alice_id = "team:room1:agent_a"
    bob_id = "team:room1:agent_b"

    bob_sub = bus.subscribe_events(agent_id=bob_id)
    wait_tool = SendToAgentWaitReplyTool(bus=bus, default_source_agent=alice_id)
    wait_tool.set_context(alice_id, "console:alice")
    reply_tool = ReplyToAgentRequestTool(bus=bus, default_source_agent=bob_id)
    reply_tool.set_context(bob_id, "console:bob")
    try:

        async def bob_coroutine() -> None:
            ev = await asyncio.wait_for(bob_sub.get(), timeout=3.0)
            assert ev.topic == "agent.direct"
            pl = ev.payload or {}
            assert pl.get(KEY_EXPECTS_REPLY) is True
            assert pl[KEY_CORRELATION_ID] == pl["message_id"]
            assert pl[KEY_SOURCE_SESSION_KEY] == "console:alice"
            out = await reply_tool.execute(
                to_agent_id=pl["sender_agent_id"],
                correlation_id=pl[KEY_CORRELATION_ID],
                content="closed-loop ok",
                target_session_key=pl.get(KEY_SOURCE_SESSION_KEY),
            )
            assert "Reply published" in out

        bob_task = asyncio.create_task(bob_coroutine())
        raw = await wait_tool.execute(
            agent_id=bob_id,
            content="ping",
            timeout_s=3,
            max_retries=0,
            base_backoff_s=0,
        )
        await bob_task
        data = json.loads(raw)
        assert data["status"] == "ok"
        assert data["correlation_id"]
        assert data["reply"]["payload"]["content"] == "closed-loop ok"
        assert data["reply"]["payload"][KEY_CORRELATION_ID] == data["correlation_id"]
        assert data["reply"]["payload"][KEY_SOURCE_SESSION_KEY] == "console:bob"
        assert data["reply"]["payload"][KEY_TARGET_SESSION_KEY] == "console:alice"
    finally:
        bob_sub.close()


@pytest.mark.asyncio
async def test_send_to_agent_wait_reply_closed_loop_subscribe_inject_path() -> None:
    """Bob gets the direct message as an injected system event; parsing it and calling ``reply_to_agent_request`` completes Alice's wait."""
    bus = MessageBus()
    alice_id = "main:session:1"
    bob_id = "sub:session:1"
    bob_inbox: list[InboundMessage] = []

    async def _bob_inject(msg: InboundMessage) -> None:
        bob_inbox.append(msg)

    wait_tool = SendToAgentWaitReplyTool(bus=bus, default_source_agent=alice_id)
    wait_tool.set_context(alice_id, "console:alice")
    reply_tool = ReplyToAgentRequestTool(bus=bus, default_source_agent=bob_id)
    reply_tool.set_context(bob_id, "console:bob")
    bob_sub_tool = SubscribeEventTool(bus=bus, default_agent_id=bob_id, inject_inbound=_bob_inject)
    bob_sub_tool.set_context(agent_id=bob_id, session_key="test:chain")
    await bob_sub_tool.execute(topics=[])

    try:

        async def alice_waits() -> str:
            return await wait_tool.execute(
                agent_id=bob_id,
                content="need answer",
                timeout_s=3,
                max_retries=0,
                base_backoff_s=0,
            )

        alice_task = asyncio.create_task(alice_waits())
        for _ in range(150):
            if bob_inbox:
                break
            await asyncio.sleep(0.02)
        assert bob_inbox, "Bob should receive injected agent.direct with [REPLY REQUIRED]"
        text = bob_inbox[0].content
        assert "[REPLY REQUIRED]" in text
        assert "reply_to_agent_request" in text
        pl = _payload_from_injected_event_text(text)
        assert pl.get(KEY_EXPECTS_REPLY) is True
        assert pl[KEY_CORRELATION_ID] == pl["message_id"]
        await reply_tool.execute(
            to_agent_id=pl["sender_agent_id"],
            correlation_id=pl[KEY_CORRELATION_ID],
            content="from inject path",
        )
        raw = await alice_task
        data = json.loads(raw)
        assert data["status"] == "ok"
        assert data["reply"]["payload"]["content"] == "from inject path"
    finally:
        bob_sub_tool.cancel_all_background_subscriptions()
        await asyncio.sleep(0.05)


@pytest.mark.asyncio
async def test_send_to_agent_wait_reply_times_out_without_reply() -> None:
    """If the peer never publishes ``agent.request.reply``, the waiter returns timeout status."""
    bus = MessageBus()
    wait_tool = SendToAgentWaitReplyTool(bus=bus, default_source_agent="lonely")
    wait_tool.set_context("lonely")
    raw = await wait_tool.execute(
        agent_id="nobody_online",
        content="hello",
        timeout_s=1,
        max_retries=0,
        base_backoff_s=0,
    )
    data = json.loads(raw)
    assert data["status"] == "timeout"
    assert data.get("reply") is None
