"""Subagent manager for background task execution."""

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from loguru import logger

from nanobot.agent.context import ContextBuilder
from nanobot.agent.hook import AgentHook, AgentHookContext
from nanobot.agent.profile_resolver import (
    ProfileStore,
    ResolvedProfile,
    build_profile_system_prompt,
    is_tool_allowed,
    resolve_profile,
)
from nanobot.agent.runner import AgentRunner, AgentRunSpec
from nanobot.agent.skills import BUILTIN_SKILLS_DIR
from nanobot.agent.tools.events import (
    ListEventSubscribersTool,
    PublishEventTool,
    ReplyToAgentRequestTool,
    SendToAgentTool,
    SendToAgentWaitReplyTool,
    SubscribeEventTool,
)
from nanobot.agent.tools.filesystem import EditFileTool, ListDirTool, ReadFileTool, WriteFileTool
from nanobot.agent.tools.registry import ToolRegistry
from nanobot.agent.tools.search import GlobTool, GrepTool
from nanobot.agent.tools.shell import ExecTool
from nanobot.agent.tools.web import WebFetchTool, WebSearchTool
from nanobot.bus.envelope import TARGET_BROADCAST
from nanobot.bus.events import AgentEvent, InboundMessage
from nanobot.bus.queue import MessageBus
from nanobot.config.profile import AgentProfile
from nanobot.config.schema import (
    AgentDefaults,
    ExecToolConfig,
    ToolsConfig,
    WebToolsConfig,
)
from nanobot.providers.base import LLMProvider
from nanobot.session.manager import SessionManager
from nanobot.session.transcript import SessionTranscriptWriter
from nanobot.utils.prompt_templates import render_template


@dataclass(slots=True)
class SubagentStatus:
    """Real-time status of a running subagent."""

    task_id: str
    label: str
    task_description: str
    started_at: float  # time.monotonic()
    phase: str = "initializing"  # initializing | awaiting_tools | tools_completed | final_response | done | error
    iteration: int = 0
    tool_events: list = field(default_factory=list)  # [{name, status, detail}, ...]
    usage: dict = field(default_factory=dict)  # token usage
    stop_reason: str | None = None
    error: str | None = None
    parent_agent_id: str | None = None
    team_id: str | None = None
    origin_channel: str | None = None
    origin_chat_id: str | None = None
    # ``session_key`` is the sub-agent's own transcript key (``subagent:<parent>:<task_id>``)
    # so the console can fetch its dedicated transcript via /sessions/{key}/transcript.
    session_key: str | None = None
    # Original parent session key the sub-agent was spawned from (``console:...`` / ``cli:...`` / ...).
    parent_session_key: str | None = None
    completed_at: float | None = None
    profile_id: str | None = None  # Resolved profile (None when running as inherited sub-agent)


class _SubagentHook(AgentHook):
    """Hook for subagent execution — logs tool calls and updates status.

    When ``transcript`` and ``session_key`` are supplied, each iteration's
    newly-appended messages are flushed to the sub-agent's own transcript
    file so the console can render the live conversation while it runs.
    """

    def __init__(
        self,
        task_id: str,
        status: SubagentStatus | None = None,
        *,
        transcript: SessionTranscriptWriter | None = None,
        session_key: str | None = None,
        initial_message_count: int = 0,
    ) -> None:
        super().__init__()
        self._task_id = task_id
        self._status = status
        self._transcript = transcript
        self._session_key = session_key
        # Tracks how many entries of context.messages have already been
        # written to the transcript. Initial system+user messages are
        # flushed up-front by SubagentManager so we start past them.
        self._written_count = initial_message_count

    async def before_execute_tools(self, context: AgentHookContext) -> None:
        for tool_call in context.tool_calls:
            args_str = json.dumps(tool_call.arguments, ensure_ascii=False)
            logger.debug(
                "Subagent [{}] executing: {} with arguments: {}",
                self._task_id,
                tool_call.name,
                args_str,
            )

    async def after_iteration(self, context: AgentHookContext) -> None:
        # Flush any messages the runner appended during this iteration so the
        # sub-agent transcript stays in sync turn-by-turn (assistant reply +
        # any tool result messages).
        self._flush_transcript(context.messages)
        if self._status is None:
            return
        self._status.iteration = context.iteration
        self._status.tool_events = list(context.tool_events)
        self._status.usage = dict(context.usage)
        if context.error:
            self._status.error = str(context.error)

    def _flush_transcript(self, messages: list[dict[str, Any]]) -> None:
        if self._transcript is None or not self._session_key:
            return
        if self._written_count >= len(messages):
            return
        for m in messages[self._written_count:]:
            try:
                self._transcript.append_raw_turn_message(self._session_key, m)
            except Exception as exc:  # pragma: no cover - transcript IO is best-effort
                logger.debug(
                    "Subagent [{}] transcript flush failed: {}", self._task_id, exc
                )
                break
        self._written_count = len(messages)


class SubagentManager:
    """Manages background subagent execution."""

    def __init__(
        self,
        provider: LLMProvider,
        workspace: Path,
        bus: MessageBus,
        max_tool_result_chars: int,
        model: str | None = None,
        web_config: "WebToolsConfig | None" = None,
        exec_config: "ExecToolConfig | None" = None,
        restrict_to_workspace: bool = False,
        disabled_skills: list[str] | None = None,
        timezone: str | None = None,
        parent_agent_id: str = "",
        profile_store: ProfileStore | None = None,
        base_defaults: AgentDefaults | None = None,
        base_tools: ToolsConfig | None = None,
        transcript_writer: SessionTranscriptWriter | None = None,
        session_manager: SessionManager | None = None,
    ):
        self.provider = provider
        self.workspace = workspace
        self.bus = bus
        self.timezone = timezone
        self.parent_agent_id = parent_agent_id
        self.model = model or provider.get_default_model()
        self.web_config = web_config or WebToolsConfig()
        self.max_tool_result_chars = max_tool_result_chars
        self.exec_config = exec_config or ExecToolConfig()
        self.restrict_to_workspace = restrict_to_workspace
        self.disabled_skills = set(disabled_skills or [])
        self.runner = AgentRunner(provider)
        self._running_tasks: dict[str, asyncio.Task[None]] = {}
        self._task_statuses: dict[str, SubagentStatus] = {}
        # Tracks a sub-agent's own session_key (subagent:<parent>:<task_id>)
        # so cancel_by_session can still target the original parent key while
        # the sub-agent's transcript lives at a separate key.
        self._session_tasks: dict[str, set[str]] = {}  # parent session_key -> {task_id, ...}
        self._task_history_limit = 200
        self.profile_store = profile_store or ProfileStore(workspace)
        self._transcript = transcript_writer
        # Optional session manager — when supplied, the sub-agent creates an
        # empty ``sessions/<key>.jsonl`` placeholder so the file is visible in
        # the console session list (transcript writes alone don't create one).
        self._session_manager = session_manager
        # Base configs used when resolving profiles into concrete settings.
        # Fall back to a model-pinned AgentDefaults so resolution still works
        # in lightweight tests that don't construct a full Config.
        self._base_defaults = base_defaults or AgentDefaults(
            workspace=str(workspace),
            model=self.model,
            max_tool_result_chars=self.max_tool_result_chars,
            disabled_skills=list(self.disabled_skills),
            timezone=self.timezone or "UTC",
        )
        self._base_tools = base_tools or ToolsConfig(
            web=self.web_config,
            exec=self.exec_config,
            restrict_to_workspace=self.restrict_to_workspace,
        )

    async def spawn(
        self,
        task: str,
        label: str | None = None,
        origin_channel: str = "cli",
        origin_chat_id: str = "direct",
        session_key: str | None = None,
        parent_agent_id: str | None = None,
        team_id: str | None = None,
        profile_id: str | None = None,
        profile_inline: AgentProfile | None = None,
    ) -> str:
        """Spawn a subagent to execute a task in the background."""
        task_id = await self.spawn_task(
            task=task,
            label=label,
            origin_channel=origin_channel,
            origin_chat_id=origin_chat_id,
            session_key=session_key,
            parent_agent_id=parent_agent_id,
            team_id=team_id,
            profile_id=profile_id,
            profile_inline=profile_inline,
        )
        display_label = (label or task[:30]).strip() or task_id
        if len(display_label) > 30:
            display_label = f"{display_label[:30]}..."
        suffix = f" with profile '{profile_id}'" if profile_id else ""
        return (
            f"Subagent [{display_label}]{suffix} started (id: {task_id}). "
            "I'll notify you when it completes."
        )

    async def spawn_task(
        self,
        *,
        task: str,
        label: str | None = None,
        origin_channel: str = "cli",
        origin_chat_id: str = "direct",
        session_key: str | None = None,
        parent_agent_id: str | None = None,
        team_id: str | None = None,
        profile_id: str | None = None,
        profile_inline: AgentProfile | None = None,
    ) -> str:
        """Spawn a subagent task and return the generated task id."""
        task_id = str(uuid.uuid4())[:8]
        display_label = label or task[:30] + ("..." if len(task) > 30 else "")
        origin = {"channel": origin_channel, "chat_id": origin_chat_id, "session_key": session_key}

        # Resolve the profile up-front so callers see ``ValueError`` for
        # unknown ids before a background task is created.
        resolved = self._resolve_profile(profile_id=profile_id, profile_inline=profile_inline)
        effective_profile_id = (
            resolved.profile.id if resolved is not None else None
        )

        sub_session_key = self._build_subagent_session_key(session_key, task_id)

        status = SubagentStatus(
            task_id=task_id,
            label=display_label,
            task_description=task,
            started_at=time.monotonic(),
            parent_agent_id=parent_agent_id or self.parent_agent_id or None,
            team_id=team_id,
            origin_channel=origin_channel,
            origin_chat_id=origin_chat_id,
            session_key=sub_session_key,
            parent_session_key=session_key,
            profile_id=effective_profile_id,
        )
        self._task_statuses[task_id] = status

        bg_task = asyncio.create_task(
            self._run_subagent(task_id, task, display_label, origin, status, resolved)
        )
        self._running_tasks[task_id] = bg_task
        if session_key:
            self._session_tasks.setdefault(session_key, set()).add(task_id)

        def _cleanup(_: asyncio.Task) -> None:
            self._running_tasks.pop(task_id, None)
            st = self._task_statuses.get(task_id)
            if st is not None and st.completed_at is None:
                st.completed_at = time.monotonic()
                if _.cancelled() and st.phase not in {"done", "error"}:
                    st.phase = "cancelled"
            if session_key and (ids := self._session_tasks.get(session_key)):
                ids.discard(task_id)
                if not ids:
                    del self._session_tasks[session_key]
            if len(self._task_statuses) > self._task_history_limit:
                stale = sorted(
                    self._task_statuses.values(),
                    key=lambda item: item.completed_at or item.started_at,
                )[: max(0, len(self._task_statuses) - self._task_history_limit)]
                for row in stale:
                    self._task_statuses.pop(row.task_id, None)

        bg_task.add_done_callback(_cleanup)

        logger.info("Spawned subagent [{}]: {}", task_id, display_label)
        return task_id

    @staticmethod
    def _build_subagent_session_key(
        parent_session_key: str | None,
        task_id: str,
    ) -> str:
        """Compose the dedicated session_key used for the sub-agent transcript.

        Format: ``subagent:<parent_session_key|orphan>:<task_id>`` — keeps the
        parent context inline so the console can group sub-agents under their
        originator while still routing transcript lookups by a unique key.
        """
        parent = (parent_session_key or "").strip() or "orphan"
        return f"subagent:{parent}:{task_id}"

    def _resolve_profile(
        self,
        *,
        profile_id: str | None,
        profile_inline: AgentProfile | None,
    ) -> ResolvedProfile | None:
        """Return the resolved profile, or ``None`` when no override is requested."""
        if profile_inline is not None:
            profile = profile_inline
        elif profile_id:
            profile = self.profile_store.load(profile_id)
            if profile is None:
                raise ValueError(f"Unknown sub-agent profile: {profile_id!r}")
        else:
            return None
        return resolve_profile(
            profile,
            base_defaults=self._base_defaults,
            base_tools=self._base_tools,
            workspace=self.workspace,
        )

    def _build_subagent_tools(
        self,
        *,
        task_id: str,
        origin: dict[str, str],
        resolved: ResolvedProfile | None,
    ) -> ToolRegistry:
        """Register sub-agent tools, honouring the profile's allowed_tools whitelist."""
        if resolved is not None:
            web = resolved.web_config
            exec_cfg = resolved.exec_config
            restrict = resolved.restrict_to_workspace
            allowed = resolved.allowed_tools
            max_chars = resolved.max_tool_result_chars
        else:
            web = self.web_config
            exec_cfg = self.exec_config
            restrict = self.restrict_to_workspace
            allowed = None
            max_chars = self.max_tool_result_chars
        del max_chars  # currently informational; runner pulls it from spec

        tools = ToolRegistry()
        allowed_dir = self.workspace if (restrict or exec_cfg.sandbox) else None
        extra_read = [BUILTIN_SKILLS_DIR] if allowed_dir else None

        def _register(name: str, factory) -> None:
            if not is_tool_allowed(name, allowed):
                return
            tools.register(factory())

        _register(
            "read_file",
            lambda: ReadFileTool(
                workspace=self.workspace,
                allowed_dir=allowed_dir,
                extra_allowed_dirs=extra_read,
            ),
        )
        _register(
            "write_file",
            lambda: WriteFileTool(workspace=self.workspace, allowed_dir=allowed_dir),
        )
        _register(
            "edit_file",
            lambda: EditFileTool(workspace=self.workspace, allowed_dir=allowed_dir),
        )
        _register(
            "list_dir",
            lambda: ListDirTool(workspace=self.workspace, allowed_dir=allowed_dir),
        )
        _register(
            "glob",
            lambda: GlobTool(workspace=self.workspace, allowed_dir=allowed_dir),
        )
        _register(
            "grep",
            lambda: GrepTool(workspace=self.workspace, allowed_dir=allowed_dir),
        )
        if exec_cfg.enable:
            _register(
                "exec",
                lambda: ExecTool(
                    working_dir=str(self.workspace),
                    timeout=exec_cfg.timeout,
                    restrict_to_workspace=restrict,
                    sandbox=exec_cfg.sandbox,
                    path_append=exec_cfg.path_append,
                    allowed_env_keys=exec_cfg.allowed_env_keys,
                ),
            )
        if web.enable:
            _register(
                "web_search",
                lambda: WebSearchTool(config=web.search, proxy=web.proxy),
            )
            _register("web_fetch", lambda: WebFetchTool(proxy=web.proxy))

        # Event channel tools (used by sub-agents to talk back / listen).
        # Subscribe tool's context is set after registration.
        subagent_id = f"sub:{task_id}"
        _register(
            "publish_event",
            lambda: PublishEventTool(bus=self.bus, default_source_agent=subagent_id),
        )
        _register(
            "send_to_agent",
            lambda: SendToAgentTool(bus=self.bus, default_source_agent=subagent_id),
        )
        _register(
            "send_to_agent_wait_reply",
            lambda: SendToAgentWaitReplyTool(bus=self.bus, default_source_agent=subagent_id),
        )
        _register(
            "reply_to_agent_request",
            lambda: ReplyToAgentRequestTool(bus=self.bus, default_source_agent=subagent_id),
        )
        if is_tool_allowed("subscribe_event", allowed):
            subscribe_tool = SubscribeEventTool(
                bus=self.bus,
                default_agent_id=subagent_id,
                inject_inbound=self.bus.publish_inbound,
            )
            subscribe_tool.set_context(
                agent_id=subagent_id,
                session_key=origin.get("session_key"),
                channel=origin["channel"],
                chat_id=origin["chat_id"],
            )
            tools.register(subscribe_tool)
        _register(
            "list_event_subscribers",
            lambda: ListEventSubscribersTool(bus=self.bus),
        )
        return tools

    async def _run_subagent(
        self,
        task_id: str,
        task: str,
        label: str,
        origin: dict[str, str],
        status: SubagentStatus,
        resolved: ResolvedProfile | None = None,
    ) -> None:
        """Execute the subagent task and announce the result."""
        logger.info("Subagent [{}] starting task: {}", task_id, label)

        async def _on_checkpoint(payload: dict) -> None:
            status.phase = payload.get("phase", status.phase)
            status.iteration = payload.get("iteration", status.iteration)

        sub_session_key = status.session_key or self._build_subagent_session_key(
            origin.get("session_key"), task_id
        )
        parent_session_key = status.parent_session_key or origin.get("session_key")

        # Materialise a placeholder session file so the sub-agent surfaces in
        # ``GET /sessions`` (transcript writes alone don't create the
        # ``sessions/<key>.jsonl`` metadata row the console list reads).
        self._ensure_session_placeholder(sub_session_key)

        # Emit a ``subagent_start`` marker on the parent transcript so the
        # console can render an inline placeholder pointing at the dedicated
        # sub-agent transcript.
        self._emit_parent_event(
            parent_session_key,
            "subagent_start",
            content=f"Subagent [{label}] started: {task}",
            metadata={
                "task_id": task_id,
                "label": label,
                "subagent_session_key": sub_session_key,
                "task_description": task,
                "profile_id": status.profile_id,
            },
        )

        try:
            tools = self._build_subagent_tools(
                task_id=task_id, origin=origin, resolved=resolved
            )

            if resolved is not None:
                system_prompt = build_profile_system_prompt(
                    resolved,
                    workspace=self.workspace,
                    channel=origin.get("channel"),
                    chat_id=origin.get("chat_id"),
                    timezone=self.timezone,
                )
                effective_model = resolved.model
                effective_max_chars = resolved.max_tool_result_chars
                effective_max_iter = resolved.defaults.max_tool_iterations
            else:
                system_prompt = self._build_subagent_prompt()
                effective_model = self.model
                effective_max_chars = self.max_tool_result_chars
                effective_max_iter = 15

            runtime = ContextBuilder._build_runtime_context(
                origin["channel"],
                origin["chat_id"],
                self.timezone,
            )
            messages: list[dict[str, Any]] = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"{runtime}\n\n{task}"},
            ]

            # Persist the seed system+user messages immediately so the console
            # can render the sub-agent's task brief while the LLM is still
            # working on the first turn.
            self._flush_initial_messages(sub_session_key, messages)

            result = await self.runner.run(
                AgentRunSpec(
                    initial_messages=messages,
                    tools=tools,
                    model=effective_model,
                    max_iterations=effective_max_iter,
                    max_tool_result_chars=effective_max_chars,
                    hook=_SubagentHook(
                        task_id,
                        status,
                        transcript=self._transcript,
                        session_key=sub_session_key,
                        initial_message_count=len(messages),
                    ),
                    max_iterations_message="Task completed but no final response was generated.",
                    error_message=None,
                    fail_on_tool_error=True,
                    workspace=self.workspace,
                    session_key=sub_session_key,
                    checkpoint_callback=_on_checkpoint,
                )
            )
            status.phase = "done"
            status.stop_reason = result.stop_reason
            status.completed_at = time.monotonic()

            # Make sure any tail messages produced after the final hook tick
            # (e.g. assistant final response) land in the transcript too.
            self._flush_result_tail(
                sub_session_key, getattr(result, "messages", None)
            )

            if result.stop_reason == "tool_error":
                status.tool_events = list(result.tool_events)
                await self._announce_result(
                    task_id,
                    label,
                    task,
                    self._format_partial_progress(result),
                    origin,
                    "error",
                    sub_session_key=sub_session_key,
                    parent_session_key=parent_session_key,
                )
            elif result.stop_reason == "error":
                await self._announce_result(
                    task_id,
                    label,
                    task,
                    result.error or "Error: subagent execution failed.",
                    origin,
                    "error",
                    sub_session_key=sub_session_key,
                    parent_session_key=parent_session_key,
                )
            else:
                final_result = (
                    result.final_content or "Task completed but no final response was generated."
                )
                logger.info("Subagent [{}] completed successfully", task_id)
                await self._announce_result(
                    task_id,
                    label,
                    task,
                    final_result,
                    origin,
                    "ok",
                    sub_session_key=sub_session_key,
                    parent_session_key=parent_session_key,
                )

        except Exception as e:
            status.phase = "error"
            status.error = str(e)
            status.completed_at = time.monotonic()
            logger.error("Subagent [{}] failed: {}", task_id, e)
            await self._announce_result(
                task_id,
                label,
                task,
                f"Error: {e}",
                origin,
                "error",
                sub_session_key=sub_session_key,
                parent_session_key=parent_session_key,
            )

    async def _announce_result(
        self,
        task_id: str,
        label: str,
        task: str,
        result: str,
        origin: dict[str, str],
        status: str,
        *,
        sub_session_key: str | None = None,
        parent_session_key: str | None = None,
    ) -> None:
        """Announce the subagent result to the main agent via the message bus."""
        status_text = "completed successfully" if status == "ok" else "failed"

        announce_content = render_template(
            "agent/subagent_announce.md",
            label=label,
            status_text=status_text,
            task=task,
            result=result,
        )

        # Drop a structured ``subagent_done`` / ``subagent_error`` row on the
        # parent transcript so console viewers can navigate to the sub-agent's
        # own session for the full conversation.
        event_name = "subagent_done" if status == "ok" else "subagent_error"
        excerpt = result if len(result) <= 400 else result[:400] + "…"
        self._emit_parent_event(
            parent_session_key,
            event_name,
            content=f"Subagent [{label}] {status_text}: {excerpt}",
            metadata={
                "task_id": task_id,
                "label": label,
                "subagent_session_key": sub_session_key,
                "status": status,
                "result_excerpt": excerpt,
            },
        )

        # Inject as system message to trigger main agent.
        # Use session_key_override to align with the main agent's effective
        # session key (which accounts for unified sessions) so the result is
        # routed to the correct pending queue (mid-turn injection) instead of
        # being dispatched as a competing independent task.
        override = origin.get("session_key") or f"{origin['channel']}:{origin['chat_id']}"
        msg = InboundMessage(
            channel="system",
            sender_id="subagent",
            chat_id=f"{origin['channel']}:{origin['chat_id']}",
            content=announce_content,
            session_key_override=override,
            metadata={
                "injected_event": "subagent_result",
                "subagent_task_id": task_id,
                "subagent_session_key": sub_session_key,
            },
        )

        await self.bus.publish_inbound(msg)
        # Also fire a pub/sub event so other agents / dashboards can
        # observe subagent completions without being the origin agent.
        # The target is broadcast so the original parent agent receives
        # it regardless of how the subagent was spawned.
        try:
            await self.bus.publish_event(
                AgentEvent(
                    topic="subagent.done",
                    source_agent=f"sub:{task_id}",
                    target=TARGET_BROADCAST,
                    payload={
                        "task_id": task_id,
                        "label": label,
                        "task": task,
                        "status": status,
                        "origin_channel": origin.get("channel"),
                        "origin_chat_id": origin.get("chat_id"),
                        "parent_agent_id": self.parent_agent_id or None,
                    },
                )
            )
        except Exception as exc:  # pragma: no cover - event channel is best-effort
            logger.debug("subagent.done event publish failed: {}", exc)
        logger.debug(
            "Subagent [{}] announced result to {}:{}", task_id, origin["channel"], origin["chat_id"]
        )

    def _ensure_session_placeholder(self, sub_session_key: str) -> None:
        """Create an empty ``sessions/<key>.jsonl`` if it doesn't exist yet.

        The placeholder lets the console session list pick up sub-agent
        transcripts (``list_session_rows`` enumerates the sessions directory).
        Errors are swallowed because session bookkeeping must never block the
        sub-agent loop itself.
        """
        if self._session_manager is None or not sub_session_key:
            return
        try:
            existing = self._session_manager._load(sub_session_key)
            if existing is not None:
                return
            from nanobot.session.manager import Session

            session = Session(
                key=sub_session_key,
                agent_timezone=self._session_manager.agent_timezone,
            )
            self._session_manager.save(session)
        except Exception as exc:  # pragma: no cover - bookkeeping is best-effort
            logger.debug(
                "Subagent session placeholder for {} failed: {}", sub_session_key, exc
            )

    def _emit_parent_event(
        self,
        parent_session_key: str | None,
        event: str,
        *,
        content: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Append a structured sub-agent event to the parent transcript.

        No-ops when transcript persistence is disabled or there is no parent
        session (e.g. CLI direct spawns without an upstream conversation).
        """
        if self._transcript is None or not parent_session_key:
            return
        try:
            self._transcript.append_event(
                parent_session_key,
                event,
                content=content,
                metadata=metadata,
            )
        except Exception as exc:  # pragma: no cover - transcript IO is best-effort
            logger.debug("Subagent parent event '{}' write failed: {}", event, exc)

    def _flush_initial_messages(
        self,
        sub_session_key: str,
        messages: list[dict[str, Any]],
    ) -> None:
        """Persist the seed system+user messages for the sub-agent transcript."""
        if self._transcript is None or not sub_session_key:
            return
        for m in messages:
            try:
                self._transcript.append_raw_turn_message(sub_session_key, m)
            except Exception as exc:  # pragma: no cover - transcript IO is best-effort
                logger.debug("Subagent initial transcript flush failed: {}", exc)
                break

    def _flush_result_tail(
        self,
        sub_session_key: str,
        result_messages: list[dict[str, Any]] | None,
    ) -> None:
        """Append any messages produced after the last hook tick.

        The runner appends the final assistant turn after ``after_iteration``
        runs in some stop reasons, so we read the *result* messages and write
        anything still missing from the transcript on disk.
        """
        if self._transcript is None or not sub_session_key or not result_messages:
            return
        try:
            existing = self._read_transcript_count(sub_session_key)
        except Exception as exc:  # pragma: no cover - transcript IO is best-effort
            logger.debug("Subagent transcript tail check failed: {}", exc)
            return
        if existing >= len(result_messages):
            return
        for m in result_messages[existing:]:
            try:
                self._transcript.append_raw_turn_message(sub_session_key, m)
            except Exception as exc:  # pragma: no cover - transcript IO is best-effort
                logger.debug("Subagent transcript tail flush failed: {}", exc)
                break

    def _read_transcript_count(self, session_key: str) -> int:
        """Return the number of JSONL lines currently on disk for *session_key*."""
        if self._transcript is None:
            return 0
        path = self._transcript._path(session_key)
        if not path.is_file():
            return 0
        with open(path, "r", encoding="utf-8") as f:
            return sum(1 for _ in f)

    @staticmethod
    def _format_partial_progress(result) -> str:
        completed = [e for e in result.tool_events if e["status"] == "ok"]
        failure = next((e for e in reversed(result.tool_events) if e["status"] == "error"), None)
        lines: list[str] = []
        if completed:
            lines.append("Completed steps:")
            for event in completed[-3:]:
                lines.append(f"- {event['name']}: {event['detail']}")
        if failure:
            if lines:
                lines.append("")
            lines.append("Failure:")
            lines.append(f"- {failure['name']}: {failure['detail']}")
        if result.error and not failure:
            if lines:
                lines.append("")
            lines.append("Failure:")
            lines.append(f"- {result.error}")
        return "\n".join(lines) or (result.error or "Error: subagent execution failed.")

    def _build_subagent_prompt(self) -> str:
        """Build a focused system prompt for the subagent."""
        from nanobot.agent.context import ContextBuilder
        from nanobot.agent.skills import SkillsLoader

        time_ctx = ContextBuilder._build_runtime_context(None, None)
        skills_summary = SkillsLoader(
            self.workspace,
            disabled_skills=self.disabled_skills,
        ).build_skills_summary()
        return render_template(
            "agent/subagent_system.md",
            time_ctx=time_ctx,
            workspace=str(self.workspace),
            skills_summary=skills_summary or "",
        )

    async def cancel_by_session(self, session_key: str) -> int:
        """Cancel all subagents for the given session. Returns count cancelled."""
        tasks = [
            self._running_tasks[tid]
            for tid in self._session_tasks.get(session_key, [])
            if tid in self._running_tasks and not self._running_tasks[tid].done()
        ]
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        return len(tasks)

    async def cancel_task(self, task_id: str) -> bool:
        """Cancel one running subagent by task id."""
        task = self._running_tasks.get(task_id)
        if task is None or task.done():
            return False
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        status = self._task_statuses.get(task_id)
        if status is not None:
            status.phase = "cancelled"
            status.completed_at = time.monotonic()
        return True

    def get_running_count(self) -> int:
        """Return the number of currently running subagents."""
        return len(self._running_tasks)

    def get_running_count_by_session(self, session_key: str) -> int:
        """Return the number of currently running subagents for a session."""
        tids = self._session_tasks.get(session_key, set())
        return sum(
            1 for tid in tids if tid in self._running_tasks and not self._running_tasks[tid].done()
        )

    def get_task_status(self, task_id: str) -> SubagentStatus | None:
        """Return one subagent status by task id."""
        return self._task_statuses.get(task_id)

    def is_task_running(self, task_id: str) -> bool:
        """Return True when a tracked subagent task is still active."""
        task = self._running_tasks.get(task_id)
        return task is not None and not task.done()

    def list_task_statuses(self, *, include_finished: bool = True) -> list[SubagentStatus]:
        """Return tracked subagent statuses ordered by start time (newest first)."""
        rows = list(self._task_statuses.values())
        if not include_finished:
            rows = [row for row in rows if self.is_task_running(row.task_id)]
        rows.sort(key=lambda row: row.started_at, reverse=True)
        return rows
