"""In-process team member loop: one AgentLoop + bus.subscribe_events (same gateway)."""

from __future__ import annotations

import asyncio

from loguru import logger

from openpawlet.agent.loop import AgentLoop
from openpawlet.bus.envelope import target_for_agent
from openpawlet.bus.events import (
    AgentEvent,
    InboundMessage,
    render_agent_event_for_llm,
    should_handle_direct_for_session,
)
from openpawlet.bus.queue import MessageBusProtocol

_MAX_RENDER = 64_000


def render_agent_event_to_system_message(ev: AgentEvent) -> str:
    """Render like :meth:`SubscribeEventTool._render_event` for the LLM turn."""
    return render_agent_event_for_llm(ev, max_body_chars=_MAX_RENDER)


def inbound_for_team_event(*, ev: AgentEvent, session_key: str) -> InboundMessage:
    """Build a system InboundMessage; ``chat_id`` is full *session_key* for session routing."""
    return InboundMessage(
        channel="system",
        sender_id=f"event:{ev.topic}",
        chat_id=session_key,
        content=render_agent_event_to_system_message(ev),
        session_key_override=session_key,
        metadata={
            "injected_event": "agent_event",
            "event_topic": ev.topic,
            "event_source_agent": ev.source_agent,
            "event_target": ev.target,
            "event_message_id": ev.message_id,
            "origin_channel": "team",
        },
    )


async def run_team_member_event_loop(
    bus: MessageBusProtocol,
    loop: AgentLoop,
    *,
    session_key: str,
) -> None:
    """Consume ``agent.<id>`` and broadcast events; feed :meth:`AgentLoop._process_message`."""
    if not loop.agent_id:
        logger.error("team member loop missing agent_id")
        return
    sub_api = getattr(bus, "subscribe_events", None)
    if sub_api is None:
        raise RuntimeError(
            "Message bus has no subscribe_events (ZMQ / events path required for teams)"
        )

    await loop._connect_mcp()
    sub = sub_api(
        agent_id=loop.agent_id,
        agent_name=loop.agent_name,
        topics=(),
        include_broadcast=True,
    )
    logger.info(
        "Team member event loop started (agent_id={} name={} session={})",
        loop.agent_id,
        loop.agent_name or "-",
        session_key,
    )
    list_pending = getattr(bus, "list_pending_direct_events", None)
    ack_pending = getattr(bus, "ack_pending_direct_event", None)
    if callable(list_pending) and callable(ack_pending):
        try:
            pending: list[AgentEvent] = await list_pending(agent_id=loop.agent_id)
        except Exception:
            pending = []
            logger.exception("failed to load pending direct events (agent_id={})", loop.agent_id)
        for ev in pending:
            if not should_handle_direct_for_session(ev, session_key):
                continue
            msg = inbound_for_team_event(ev=ev, session_key=session_key)
            try:
                await loop._process_message(msg, session_key=session_key)
                if await ack_pending(agent_id=loop.agent_id, message_id=ev.message_id):
                    logger.info(
                        "replayed_direct_message agent_id={} message_id={}",
                        loop.agent_id,
                        ev.message_id,
                    )
            except Exception:
                logger.exception(
                    "failed replaying pending direct event (agent_id={} message_id={})",
                    loop.agent_id,
                    ev.message_id,
                )
    try:
        while True:
            ev = await sub.get()
            if not should_handle_direct_for_session(ev, session_key):
                continue
            msg = inbound_for_team_event(ev=ev, session_key=session_key)
            try:
                await loop._process_message(msg, session_key=session_key)
                if (
                    callable(ack_pending)
                    and ev.topic == "agent.direct"
                    and (ev.target or "").strip() == target_for_agent(loop.agent_id)
                ):
                    await ack_pending(agent_id=loop.agent_id, message_id=ev.message_id)
            except Exception:
                logger.exception("team member turn failed (agent_id={})", loop.agent_id)
    except asyncio.CancelledError:
        raise
    finally:
        if hasattr(sub, "close"):
            sub.close()
