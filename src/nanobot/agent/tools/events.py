"""Agent event tools: publish / subscribe / send-to-agent.

These three tools let an agent participate in the event channel of the
message bus so it can collaborate with other agents and react to
system-level events (cron fired, channels going up/down, subagents
finishing, etc.).

Delivery semantics are at-most-once (pub/sub).  Events are fire and
forget - consumers that were not subscribed at publish time will miss
them, and restarts do not replay history.  The publisher therefore
does not block on acknowledgement.
"""

from __future__ import annotations

import asyncio
import json
from contextvars import ContextVar
from typing import Any, Awaitable, Callable

from loguru import logger

from nanobot.agent.tools.base import Tool, tool_parameters
from nanobot.agent.tools.schema import (
    ArraySchema,
    IntegerSchema,
    ObjectSchema,
    StringSchema,
    tool_parameters_schema,
)
from nanobot.bus.envelope import (
    TARGET_BROADCAST,
    target_for_agent,
    target_for_topic,
)
from nanobot.bus.events import AgentEvent, InboundMessage
from nanobot.bus.queue import EventSubscription, MessageBusProtocol


_MAX_WAIT_SECONDS = 300


@tool_parameters(
    tool_parameters_schema(
        topic=StringSchema(
            "Semantic topic label for this event, e.g. 'inventory.updated'.",
            min_length=1,
        ),
        payload=ObjectSchema(
            description="Arbitrary JSON payload for subscribers.",
            additional_properties=True,
        ),
        target=StringSchema(
            "Optional SUB target prefix: 'broadcast' (default), 'agent:<id>', or 'topic:<name>'.",
            nullable=True,
        ),
        required=["topic"],
    )
)
class PublishEventTool(Tool):
    """Publish an event to every subscriber matching *target*."""

    def __init__(self, bus: MessageBusProtocol, default_source_agent: str = "agent") -> None:
        self._bus = bus
        self._default_source = default_source_agent
        self._source_ctx: ContextVar[str | None] = ContextVar(
            "publish_event_source_agent", default=None
        )

    def set_context(self, source_agent: str) -> None:
        """Set the source agent id (task-local under asyncio)."""
        self._source_ctx.set(source_agent)

    @property
    def name(self) -> str:
        return "publish_event"

    @property
    def description(self) -> str:
        return (
            "Publish a pub/sub event on the message bus.  Use this to notify "
            "other agents or system components about something that happened. "
            "target: 'broadcast' (default) sends to every subscriber; "
            "'agent:<id>' addresses a single agent; 'topic:<name>' targets "
            "subscribers of that topic.  Delivery is at-most-once."
        )

    async def execute(
        self,
        topic: str,
        payload: dict[str, Any] | None = None,
        target: str | None = None,
        **_: Any,
    ) -> str:
        resolved_target = (target or "").strip() or TARGET_BROADCAST
        source = self._source_ctx.get() or self._default_source
        ev = AgentEvent(
            topic=str(topic),
            payload=dict(payload or {}),
            source_agent=source,
            target=resolved_target,
        )
        try:
            await self._bus.publish_event(ev)
        except Exception as exc:
            return f"Error publishing event: {exc}"
        return (
            f"Event published (topic={ev.topic}, target={ev.target}, "
            f"message_id={ev.message_id})"
        )


@tool_parameters(
    tool_parameters_schema(
        agent_id=StringSchema(
            "Target agent id as shown by their subscribe handshake.",
            min_length=1,
        ),
        content=StringSchema(
            "Text content to deliver.  Serialised into the event payload.",
            min_length=1,
        ),
        metadata=ObjectSchema(
            description="Optional extra metadata attached to the event payload.",
            additional_properties=True,
        ),
        required=["agent_id", "content"],
    )
)
class SendToAgentTool(Tool):
    """Direct-message a specific agent by id."""

    def __init__(self, bus: MessageBusProtocol, default_source_agent: str = "agent") -> None:
        self._bus = bus
        self._default_source = default_source_agent
        self._source_ctx: ContextVar[str | None] = ContextVar(
            "send_to_agent_source", default=None
        )

    def set_context(self, source_agent: str) -> None:
        self._source_ctx.set(source_agent)

    @property
    def name(self) -> str:
        return "send_to_agent"

    @property
    def description(self) -> str:
        return (
            "Send a direct message to another agent by its agent_id. "
            "Equivalent to publish_event(topic='agent.direct', target='agent:<id>'). "
            "Use this for agent-to-agent collaboration.  Delivery is at-most-once; "
            "if the target agent is offline the message is lost."
        )

    async def execute(
        self,
        agent_id: str,
        content: str,
        metadata: dict[str, Any] | None = None,
        **_: Any,
    ) -> str:
        source = self._source_ctx.get() or self._default_source
        payload: dict[str, Any] = {"content": str(content)}
        if metadata:
            payload["metadata"] = dict(metadata)
        ev = AgentEvent(
            topic="agent.direct",
            payload=payload,
            source_agent=source,
            target=target_for_agent(str(agent_id)),
        )
        try:
            await self._bus.publish_event(ev)
        except Exception as exc:
            return f"Error sending message to agent: {exc}"
        return f"Message sent to agent {agent_id} (message_id={ev.message_id})"


@tool_parameters(
    tool_parameters_schema(
        topics=ArraySchema(
            StringSchema(""),
            description=(
                "List of topic prefixes to subscribe to.  An empty list keeps only "
                "broadcast + direct-addressed events."
            ),
        ),
        timeout_s=IntegerSchema(
            description=(
                "How long to wait for the next matching event, in seconds. "
                "Bounded to [1, 300]."
            ),
            minimum=1,
            maximum=_MAX_WAIT_SECONDS,
        ),
        include_broadcast=StringSchema(
            description=(
                "If 'true' (default), also receive broadcast events targeted at "
                "every agent.  Use 'false' to listen only for direct / topic events."
            ),
            nullable=True,
            enum=("true", "false"),
        ),
        required=[],
    )
)
class SubscribeEventTool(Tool):
    """Wait for (or start listening to) events on the bus.

    Two usage modes are supported:

    1. **Inline await** - when ``timeout_s`` is provided the tool waits
       for the next matching event and returns it inline as the tool
       result.  Convenient for short-lived "wait for N seconds" flows.
    2. **Background tap** - when ``timeout_s`` is omitted the tool
       installs a long-lived background listener that forwards every
       matching event back to the main agent loop as a synthetic
       :class:`InboundMessage`.  The agent can then react normally on
       its next turn without blocking the current turn.
    """

    _DEFAULT_INLINE_TIMEOUT = 30

    def __init__(
        self,
        bus: MessageBusProtocol,
        default_agent_id: str = "agent",
        inject_inbound: Callable[[InboundMessage], Awaitable[None]] | None = None,
    ) -> None:
        self._bus = bus
        self._default_agent_id = default_agent_id
        self._inject = inject_inbound
        self._agent_id_ctx: ContextVar[str | None] = ContextVar(
            "subscribe_event_agent_id", default=None
        )
        self._session_key_ctx: ContextVar[str | None] = ContextVar(
            "subscribe_event_session_key", default=None
        )
        self._channel_ctx: ContextVar[str | None] = ContextVar(
            "subscribe_event_channel", default=None
        )
        self._chat_id_ctx: ContextVar[str | None] = ContextVar(
            "subscribe_event_chat_id", default=None
        )
        self._background_tasks: dict[str, asyncio.Task[None]] = {}

    def set_context(
        self,
        *,
        agent_id: str,
        session_key: str | None = None,
        channel: str | None = None,
        chat_id: str | None = None,
    ) -> None:
        self._agent_id_ctx.set(agent_id)
        self._session_key_ctx.set(session_key)
        self._channel_ctx.set(channel)
        self._chat_id_ctx.set(chat_id)

    def set_inject_callback(
        self, inject: Callable[[InboundMessage], Awaitable[None]]
    ) -> None:
        self._inject = inject

    def cancel_background_subscription(self, key: str) -> bool:
        task = self._background_tasks.pop(key, None)
        if task is None:
            return False
        task.cancel()
        return True

    def cancel_all_background_subscriptions(self) -> int:
        tasks = list(self._background_tasks.values())
        self._background_tasks.clear()
        for task in tasks:
            task.cancel()
        return len(tasks)

    @property
    def name(self) -> str:
        return "subscribe_event"

    @property
    def description(self) -> str:
        return (
            "Listen for events on the message bus.  With timeout_s set, waits "
            "inline and returns the next matching event as JSON (or 'timeout' "
            "if none arrives in time).  Without timeout_s, installs a background "
            "listener that forwards matching events back to the agent as system "
            "messages so the agent can react on its next turn."
        )

    async def execute(
        self,
        topics: list[str] | None = None,
        timeout_s: int | None = None,
        include_broadcast: str | None = None,
        **_: Any,
    ) -> str:
        agent_id = (self._agent_id_ctx.get() or self._default_agent_id).strip()
        topics_tuple = tuple(str(t) for t in (topics or []))
        include_bcast = True
        if isinstance(include_broadcast, str):
            include_bcast = include_broadcast.lower() != "false"

        if timeout_s is None:
            return await self._install_background(agent_id, topics_tuple, include_bcast)

        bounded = max(1, min(_MAX_WAIT_SECONDS, int(timeout_s)))
        return await self._await_inline(agent_id, topics_tuple, include_bcast, bounded)

    async def _await_inline(
        self,
        agent_id: str,
        topics: tuple[str, ...],
        include_broadcast: bool,
        timeout_s: int,
    ) -> str:
        try:
            sub = self._bus.subscribe_events(
                agent_id=agent_id,
                topics=topics,
                include_broadcast=include_broadcast,
            )
        except RuntimeError as exc:
            return f"Error: events unavailable: {exc}"
        try:
            try:
                ev = await asyncio.wait_for(sub.get(), timeout=timeout_s)
            except asyncio.TimeoutError:
                return f"timeout: no events received in {timeout_s}s"
            return json.dumps(
                {
                    "topic": ev.topic,
                    "source_agent": ev.source_agent,
                    "target": ev.target,
                    "payload": ev.payload,
                    "message_id": ev.message_id,
                },
                ensure_ascii=False,
            )
        finally:
            if isinstance(sub, EventSubscription):
                sub.close()

    async def _install_background(
        self,
        agent_id: str,
        topics: tuple[str, ...],
        include_broadcast: bool,
    ) -> str:
        if self._inject is None:
            return (
                "Error: background subscriptions require an injection callback; "
                "use timeout_s to await events inline instead."
            )
        key = f"{agent_id}::{','.join(topics)}::{include_broadcast}"
        existing = self._background_tasks.get(key)
        if existing is not None and not existing.done():
            return (
                f"Already subscribed (agent_id={agent_id}, topics={list(topics)}); "
                "events will be delivered as system messages."
            )
        try:
            sub = self._bus.subscribe_events(
                agent_id=agent_id,
                topics=topics,
                include_broadcast=include_broadcast,
            )
        except RuntimeError as exc:
            return f"Error: events unavailable: {exc}"

        session_key = self._session_key_ctx.get()
        channel = self._channel_ctx.get() or "system"
        chat_id = self._chat_id_ctx.get() or agent_id

        task = asyncio.create_task(
            self._pump_background(sub, session_key, channel, chat_id),
            name=f"event-subscribe-{agent_id}",
        )
        self._background_tasks[key] = task

        def _cleanup(_: asyncio.Task[None]) -> None:
            self._background_tasks.pop(key, None)
            if isinstance(sub, EventSubscription):
                sub.close()

        task.add_done_callback(_cleanup)
        return (
            f"Subscribed in background (agent_id={agent_id}, topics={list(topics)}, "
            f"include_broadcast={include_broadcast}).  Events will be delivered as "
            "system messages."
        )

    async def _pump_background(
        self,
        sub: EventSubscription,
        session_key: str | None,
        channel: str,
        chat_id: str,
    ) -> None:
        assert self._inject is not None  # guarded by _install_background
        try:
            while True:
                ev = await sub.get()
                content = self._render_event(ev)
                msg = InboundMessage(
                    channel="system",
                    sender_id=f"event:{ev.topic}",
                    chat_id=chat_id,
                    content=content,
                    session_key_override=session_key,
                    metadata={
                        "injected_event": "agent_event",
                        "event_topic": ev.topic,
                        "event_source_agent": ev.source_agent,
                        "event_target": ev.target,
                        "event_message_id": ev.message_id,
                        "origin_channel": channel,
                    },
                )
                try:
                    await self._inject(msg)
                except Exception as exc:  # pragma: no cover - defensive
                    logger.warning("SubscribeEventTool inject failed: {}", exc)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception("SubscribeEventTool background pump crashed: {}", exc)

    @staticmethod
    def _render_event(ev: AgentEvent) -> str:
        """Render *ev* into a short system-visible message for the main loop."""
        try:
            body = json.dumps(ev.payload, ensure_ascii=False, indent=2)
        except Exception:
            body = str(ev.payload)
        return (
            f"[event] topic={ev.topic} from={ev.source_agent} target={ev.target}\n"
            f"{body}"
        )
