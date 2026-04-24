"""Tests for agent-to-agent messaging over the event bus.

These tests exercise the tool-level contract rather than booting a real
LLM provider.  They ensure that a "main" agent and a "sub" agent can
exchange direct messages through :class:`SendToAgentTool` +
:class:`SubscribeEventTool`.
"""

from __future__ import annotations

import asyncio

import pytest

from nanobot.agent.tools.events import SendToAgentTool, SubscribeEventTool
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
    sub_send = SendToAgentTool(bus=bus, default_source_agent=sub_id)
    main_sub_tool = SubscribeEventTool(
        bus=bus, default_agent_id=main_id, inject_inbound=_main_inject
    )
    main_sub_tool.set_context(agent_id=main_id, session_key="test:1")
    sub_sub_tool = SubscribeEventTool(
        bus=bus, default_agent_id=sub_id, inject_inbound=_sub_inject
    )
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
    finally:
        main_sub_tool.cancel_all_background_subscriptions()
        sub_sub_tool.cancel_all_background_subscriptions()
        await asyncio.sleep(0.05)
