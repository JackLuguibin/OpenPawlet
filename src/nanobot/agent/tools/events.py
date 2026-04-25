"""Agent event tools: publish / subscribe / send-to-agent / query-subscribers.

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
    KEY_CORRELATION_ID,
    KEY_EXPECTS_REPLY,
    KEY_REPLY_ERROR,
    KEY_SOURCE_SESSION_KEY,
    KEY_TARGET_SESSION_KEY,
    TARGET_BROADCAST,
    new_message_id,
    produced_at,
    target_for_agent,
    target_for_topic,
)
from nanobot.bus.events import (
    AgentEvent,
    InboundMessage,
    build_request_reply_event,
    render_agent_event_for_llm,
    should_handle_direct_for_session,
)
from nanobot.bus.queue import EventSubscription, MessageBusProtocol


_MAX_WAIT_SECONDS = 300


def _normalize_target_session_key(
    *,
    source_agent: str,
    target_agent: str,
    source_session_key: str,
    target_session_key: str,
) -> str:
    """Normalize per-session routing hints for direct agent messages.

    When an agent sends a direct message to itself inside a team runtime, a
    non-team target session key (for example a websocket chat session) will
    never match the member loop's ``console:team_...`` key and causes waits to
    time out. In that case, prefer the current source team session.
    """
    source = source_agent.strip()
    target = target_agent.strip()
    source_session = source_session_key.strip()
    target_session = target_session_key.strip()
    if (
        source
        and target
        and source == target
        and source_session.startswith("console:team_")
        and target_session
        and not target_session.startswith("console:team_")
    ):
        return source_session
    return target_session


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

    def set_context(
        self, source_agent: str, source_session_key: str | None = None
    ) -> None:
        """Set the source agent id (task-local under asyncio)."""
        _ = source_session_key
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
            "subscribers of that topic.  Delivery is at-most-once.  "
            "To answer a peer waiting on send_to_agent_wait_reply, prefer "
            "reply_to_agent_request instead of hand-building topic 'agent.request.reply'."
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
        target_session_key=StringSchema(
            "Optional receiver session key (for example `console:...`). "
            "When set, only matching session loops should consume this direct message.",
            nullable=True,
            min_length=1,
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
        self._source_session_ctx: ContextVar[str | None] = ContextVar(
            "send_to_agent_source_session_key", default=None
        )

    def set_context(self, source_agent: str, source_session_key: str | None = None) -> None:
        self._source_ctx.set(source_agent)
        self._source_session_ctx.set(source_session_key)

    @property
    def name(self) -> str:
        return "send_to_agent"

    @property
    def description(self) -> str:
        return (
            "Send a direct message to another agent by its agent_id. "
            "Equivalent to publish_event(topic='agent.direct', target='agent:<id>'). "
            "Use this for agent-to-agent collaboration.  The runtime keeps a "
            "best-effort mailbox for offline recipients and replays pending direct "
            "messages when they come back online."
        )

    async def execute(
        self,
        agent_id: str,
        content: str,
        metadata: dict[str, Any] | None = None,
        target_session_key: str | None = None,
        **_: Any,
    ) -> str:
        source = self._source_ctx.get() or self._default_source
        source_session = str(self._source_session_ctx.get() or "").strip()
        direct_message_id = new_message_id()
        created_at = produced_at()
        payload: dict[str, Any] = {
            "content": str(content),
            "message_id": direct_message_id,
            "sender_agent_id": source,
            "created_at": created_at,
        }
        if source_session:
            payload[KEY_SOURCE_SESSION_KEY] = source_session
        target_session = _normalize_target_session_key(
            source_agent=source,
            target_agent=str(agent_id),
            source_session_key=source_session,
            target_session_key=str(target_session_key or ""),
        )
        if target_session:
            payload[KEY_TARGET_SESSION_KEY] = target_session
        if metadata:
            payload["metadata"] = dict(metadata)
        ev = AgentEvent(
            topic="agent.direct",
            payload=payload,
            source_agent=source,
            target=target_for_agent(str(agent_id)),
            message_id=direct_message_id,
            produced_at=created_at,
        )
        try:
            await self._bus.publish_event(ev)
        except Exception as exc:
            return f"Error sending message to agent: {exc}"
        return f"Message sent to agent {agent_id} (message_id={ev.message_id})"


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
        target_session_key=StringSchema(
            "Optional receiver session key (for example `console:...`). "
            "When set, only matching session loops should consume this direct message.",
            nullable=True,
            min_length=1,
        ),
        timeout_s=IntegerSchema(
            description="Per-attempt wait for an agent.request.reply (seconds). [1, 300].",
            minimum=1,
            maximum=_MAX_WAIT_SECONDS,
        ),
        max_retries=IntegerSchema(
            description="Number of extra send attempts after the first (after a per-attempt timeout).",
            minimum=0,
            maximum=20,
        ),
        base_backoff_s=IntegerSchema(
            description=(
                "Seconds of sleep before each retry; delay = base_backoff_s * 2^attempt_index."
            ),
            minimum=0,
            maximum=120,
        ),
        required=["agent_id", "content", "timeout_s", "max_retries", "base_backoff_s"],
    )
)
class SendToAgentWaitReplyTool(Tool):
    """Direct-message another agent and wait for a correlated agent.request.reply."""

    def __init__(self, bus: MessageBusProtocol, default_source_agent: str = "agent") -> None:
        self._bus = bus
        self._default_source = default_source_agent
        self._source_ctx: ContextVar[str | None] = ContextVar(
            "send_to_agent_wait_reply_source", default=None
        )
        self._source_session_ctx: ContextVar[str | None] = ContextVar(
            "send_to_agent_wait_reply_source_session_key", default=None
        )

    def set_context(self, source_agent: str, source_session_key: str | None = None) -> None:
        self._source_ctx.set(source_agent)
        self._source_session_ctx.set(source_session_key)

    @property
    def name(self) -> str:
        return "send_to_agent_wait_reply"

    @property
    def description(self) -> str:
        return (
            "Send a direct message (agent.direct) and block until the peer replies with "
            "topic 'agent.request.reply' whose payload.correlation_id matches this request. "
            "The direct payload includes expects_reply: true, correlation_id, and message_id "
            "(the callee must use that id when replying).  The peer should use publish_event "
            "on agent.request.reply with the same correlation_id, or build_request_reply_event. "
            "You must choose timeout_s, max_retries, and base_backoff_s for this task."
        )

    async def execute(
        self,
        agent_id: str,
        content: str,
        metadata: dict[str, Any] | None = None,
        target_session_key: str | None = None,
        *,
        timeout_s: int,
        max_retries: int,
        base_backoff_s: int,
        **_: Any,
    ) -> str:
        source = self._source_ctx.get() or self._default_source
        source_session = str(self._source_session_ctx.get() or "").strip()
        direct_message_id = new_message_id()
        created_at = produced_at()
        payload: dict[str, Any] = {
            "content": str(content),
            "message_id": direct_message_id,
            "sender_agent_id": source,
            "created_at": created_at,
            KEY_CORRELATION_ID: direct_message_id,
            KEY_EXPECTS_REPLY: True,
        }
        if source_session:
            payload[KEY_SOURCE_SESSION_KEY] = source_session
        target_session = _normalize_target_session_key(
            source_agent=source,
            target_agent=str(agent_id),
            source_session_key=source_session,
            target_session_key=str(target_session_key or ""),
        )
        if target_session:
            payload[KEY_TARGET_SESSION_KEY] = target_session
        if metadata:
            payload["metadata"] = dict(metadata)
        ev = AgentEvent(
            topic="agent.direct",
            payload=payload,
            source_agent=source,
            target=target_for_agent(str(agent_id)),
            message_id=direct_message_id,
            produced_at=created_at,
        )
        request_fn = getattr(self._bus, "request_event", None)
        if not callable(request_fn):
            return "Error: request_event is not available on this message bus."
        try:
            reply, attempts, status = await request_fn(  # type: ignore[union-attr]
                ev,
                correlation_id=direct_message_id,
                timeout_s=float(timeout_s),
                max_retries=int(max_retries),
                base_backoff_s=float(base_backoff_s),
            )
        except Exception as exc:
            return f"Error: {exc}"
        out: dict[str, Any] = {
            "status": status,
            "correlation_id": direct_message_id,
            "attempts": attempts,
        }
        if reply is not None:
            pl = dict(reply.payload or {})
            if pl.get(KEY_REPLY_ERROR):
                out["error"] = pl.get(KEY_REPLY_ERROR)
            out["reply"] = {
                "topic": reply.topic,
                "source_agent": reply.source_agent,
                "target": reply.target,
                "payload": pl,
            }
        return json.dumps(out, ensure_ascii=False)


@tool_parameters(
    tool_parameters_schema(
        to_agent_id=StringSchema(
            "The requester's agent id (from the direct message: sender_agent_id).",
            min_length=1,
        ),
        correlation_id=StringSchema(
            "The request id: correlation_id (same as message_id) from that direct message. Must match exactly.",
            min_length=1,
        ),
        content=StringSchema(
            "Text to return to the requester. Use empty only together with error.",
            min_length=0,
        ),
        error=StringSchema(
            "Optional. If set, the waiter receives an error (same as a failed reply) instead of content.",
            nullable=True,
        ),
        target_session_key=StringSchema(
            "Optional receiver session key hint to include in reply payload.",
            nullable=True,
            min_length=1,
        ),
        required=["to_agent_id", "correlation_id", "content"],
    )
)
class ReplyToAgentRequestTool(Tool):
    """Publish ``agent.request.reply`` for a waiting send_to_agent_wait_reply call."""

    def __init__(self, bus: MessageBusProtocol, default_source_agent: str = "agent") -> None:
        self._bus = bus
        self._default_source = default_source_agent
        self._source_ctx: ContextVar[str | None] = ContextVar(
            "reply_to_agent_request_source", default=None
        )
        self._source_session_ctx: ContextVar[str | None] = ContextVar(
            "reply_to_agent_request_source_session_key", default=None
        )

    def set_context(self, source_agent: str, source_session_key: str | None = None) -> None:
        self._source_ctx.set(source_agent)
        self._source_session_ctx.set(source_session_key)

    @property
    def name(self) -> str:
        return "reply_to_agent_request"

    @property
    def description(self) -> str:
        return (
            "Respond to a direct message that has expects_reply / send_to_agent_wait_reply. "
            "Use sender_agent_id as to_agent_id, and the same correlation_id (or message_id) "
            "from the [REPLY REQUIRED] / agent.direct payload.  This is easier than hand-building "
            "publish_event for topic 'agent.request.reply'."
        )

    async def execute(
        self,
        to_agent_id: str,
        correlation_id: str,
        content: str = "",
        error: str | None = None,
        target_session_key: str | None = None,
        **_: Any,
    ) -> str:
        source = self._source_ctx.get() or self._default_source
        source_session = str(self._source_session_ctx.get() or "").strip()
        err: str | None = None
        if error is not None and str(error).strip():
            err = str(error).strip()
        body = str(content) if content is not None else ""
        if err is None and not body.strip():
            return "Error: provide a non-empty content, or set error= for a failure reply."
        try:
            ev = build_request_reply_event(
                correlation_id=str(correlation_id).strip(),
                to_agent_id=str(to_agent_id).strip(),
                content=body,
                source_agent=source,
                error=err,
                source_session_key=source_session or None,
                target_session_key=str(target_session_key or "").strip() or None,
            )
            await self._bus.publish_event(ev)
        except Exception as exc:
            return f"Error sending reply: {exc}"
        cid = (ev.payload or {}).get(KEY_CORRELATION_ID, "")
        return f"Reply published to agent {to_agent_id!r} (correlation_id={cid})"


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
        default_agent_name: str = "",
        inject_inbound: Callable[[InboundMessage], Awaitable[None]] | None = None,
    ) -> None:
        self._bus = bus
        self._default_agent_id = default_agent_id
        self._default_agent_name = str(default_agent_name or "").strip()
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
        session_key = self._session_key_ctx.get()
        pending = await self._load_pending_direct(agent_id)
        ev = self._first_matching_direct_for_session(pending, session_key=session_key)
        if ev is not None:
            await self._ack_pending_direct(agent_id=agent_id, message_id=ev.message_id)
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
        try:
            sub = self._bus.subscribe_events(
                agent_id=agent_id,
                agent_name=self._default_agent_name
                if agent_id == (self._default_agent_id or "").strip()
                else "",
                topics=topics,
                include_broadcast=include_broadcast,
            )
        except RuntimeError as exc:
            return f"Error: events unavailable: {exc}"
        try:
            try:
                while True:
                    ev = await asyncio.wait_for(sub.get(), timeout=timeout_s)
                    if should_handle_direct_for_session(ev, session_key):
                        break
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
                agent_name=self._default_agent_name
                if agent_id == (self._default_agent_id or "").strip()
                else "",
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
        await self._replay_pending_direct_events(
            agent_id=agent_id,
            session_key=session_key,
            channel=channel,
            chat_id=chat_id,
        )

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

    async def _load_pending_direct(self, agent_id: str) -> list[AgentEvent]:
        list_pending = getattr(self._bus, "list_pending_direct_events", None)
        if not callable(list_pending):
            return []
        try:
            return await list_pending(agent_id=agent_id)
        except Exception:
            logger.exception("SubscribeEventTool failed to list pending direct events")
            return []

    async def _ack_pending_direct(self, *, agent_id: str, message_id: str) -> bool:
        ack_pending = getattr(self._bus, "ack_pending_direct_event", None)
        if not callable(ack_pending):
            return False
        try:
            ok = await ack_pending(agent_id=agent_id, message_id=message_id)
        except Exception:
            logger.exception("SubscribeEventTool failed to ack pending direct event")
            return False
        return bool(ok)

    async def _replay_pending_direct_events(
        self,
        *,
        agent_id: str,
        session_key: str | None,
        channel: str,
        chat_id: str,
    ) -> None:
        if self._inject is None:
            return
        pending = await self._load_pending_direct(agent_id)
        for ev in pending:
            if not should_handle_direct_for_session(ev, session_key):
                continue
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
                if await self._ack_pending_direct(agent_id=agent_id, message_id=ev.message_id):
                    logger.info(
                        "replayed_direct_message agent_id={} message_id={}",
                        agent_id,
                        ev.message_id,
                    )
            except Exception:
                logger.exception(
                    "SubscribeEventTool failed replaying pending direct event {}",
                    ev.message_id,
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
                if not should_handle_direct_for_session(ev, session_key):
                    continue
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
        return render_agent_event_for_llm(ev)

    @staticmethod
    def _first_matching_direct_for_session(
        events: list[AgentEvent],
        *,
        session_key: str | None,
    ) -> AgentEvent | None:
        for ev in events:
            if should_handle_direct_for_session(ev, session_key):
                return ev
        return None


@tool_parameters(
    tool_parameters_schema(
        topic=StringSchema(
            description=(
                "Optional topic filter. If set, only subscribers that match this topic "
                "prefix rule are returned."
            ),
            nullable=True,
            min_length=1,
        ),
        required=[],
    )
)
class ListEventSubscribersTool(Tool):
    """Inspect currently visible event subscribers for agent discovery."""

    def __init__(self, bus: MessageBusProtocol) -> None:
        self._bus = bus

    @property
    def name(self) -> str:
        return "list_event_subscribers"

    @property
    def description(self) -> str:
        return (
            "List currently active event subscribers so you can discover which "
            "agent_id (and display name, when available) are online and can "
            "receive send_to_agent messages. Accepts an optional topic filter."
        )

    async def execute(
        self,
        topic: str | None = None,
        **_: Any,
    ) -> str:
        list_subscribers = getattr(self._bus, "list_event_subscribers", None)
        if not callable(list_subscribers):
            return "Error: event subscriber discovery is unavailable on this message bus."
        try:
            rows = await list_subscribers(topic=topic)
        except Exception as exc:
            return f"Error listing event subscribers: {exc}"
        payload = {
            "topic_filter": str(topic).strip() if topic else None,
            "count": len(rows),
            "subscribers": rows,
        }
        return json.dumps(payload, ensure_ascii=False)
