"""Agent loop: the core processing engine."""

from __future__ import annotations

import asyncio
import dataclasses
import inspect
import json
import os
import re
import socket
import time
import uuid
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack, nullcontext
from pathlib import Path
from typing import TYPE_CHECKING, Any

from loguru import logger

from openpawlet.agent.autocompact import AutoCompact
from openpawlet.agent.context import ContextBuilder
from openpawlet.agent.hook import AgentHook, AgentHookContext, CompositeHook
from openpawlet.agent.memory import Consolidator, Dream
from openpawlet.agent.outbound import reply_to as _reply_to
from openpawlet.agent.runner import _MAX_INJECTIONS_PER_TURN, AgentRunner, AgentRunSpec
from openpawlet.agent.skills import BUILTIN_SKILLS_DIR
from openpawlet.agent.subagent import SubagentManager
from openpawlet.agent.tools.ask import (
    AskUserTool,
    ask_user_options_from_messages,
    ask_user_outbound,
    ask_user_tool_result_messages,
    pending_ask_user_id,
)
from openpawlet.agent.tools.cron import CronTool
from openpawlet.agent.tools.events import (
    ListEventSubscribersTool,
    PublishEventTool,
    ReplyToAgentRequestTool,
    SendToAgentTool,
    SendToAgentWaitReplyTool,
    SubscribeEventTool,
)
from openpawlet.agent.tools.filesystem import EditFileTool, ListDirTool, ReadFileTool, WriteFileTool
from openpawlet.agent.tools.message import MessageTool
from openpawlet.agent.tools.notebook import NotebookEditTool
from openpawlet.agent.tools.registry import ToolRegistry
from openpawlet.agent.tools.search import GlobTool, GrepTool
from openpawlet.agent.tools.self import MyTool
from openpawlet.agent.tools.shell import ExecTool
from openpawlet.agent.tools.spawn import SpawnTool
from openpawlet.agent.tools.web import WebFetchTool, WebSearchTool
from openpawlet.bus.events import (
    InboundMessage,
    OutboundMessage,
    peer_user_visible_from_llm_event_block,
)
from openpawlet.bus.queue import MessageBus
from openpawlet.command import CommandContext, CommandRouter, register_builtin_commands
from openpawlet.config.paths import workspace_console_subdir
from openpawlet.config.schema import AgentDefaults, Config
from openpawlet.observability.telemetry import get_trace_id
from openpawlet.providers.base import LLMProvider
from openpawlet.session.context_snapshot import SessionContextWriter
from openpawlet.session.manager import Session, SessionManager
from openpawlet.session.transcript import SessionTranscriptWriter
from openpawlet.utils.document import extract_documents
from openpawlet.utils.helpers import (
    image_placeholder_text,
    local_now,
    timestamp,
)
from openpawlet.utils.helpers import (
    truncate_text as truncate_text_fn,
)
from openpawlet.utils.runtime import EMPTY_FINAL_RESPONSE_MESSAGE

if TYPE_CHECKING:
    from openpawlet.config.schema import ChannelsConfig, ExecToolConfig, ToolsConfig, WebToolsConfig
    from openpawlet.cron.service import CronService


UNIFIED_SESSION_KEY = "unified:default"
_TEAM_SESSION_KEY_RE = re.compile(r"^console:team_[^_]+_room_[^_]+_agent_.+$")
_TEAM_SESSION_KEY_WITH_AGENT_RE = re.compile(
    r"^console:team_[^_]+_room_[^_]+_agent_(?P<agent_id>.+?)(?:_run_[^_]+)?$"
)


def _safe_nodename() -> str:
    """Return a cross-platform node name for synthetic agent IDs."""
    try:
        return socket.gethostname() or "unknown-host"
    except Exception:
        return "unknown-host"


class _LoopHook(AgentHook):
    """Core hook for the main loop."""

    def __init__(
        self,
        agent_loop: AgentLoop,
        on_progress: Callable[..., Awaitable[None]] | None = None,
        on_stream: Callable[[str], Awaitable[None]] | None = None,
        on_stream_end: Callable[..., Awaitable[None]] | None = None,
        on_tool_event: Callable[..., Awaitable[None]] | None = None,
        *,
        channel: str = "cli",
        chat_id: str = "direct",
        message_id: str | None = None,
        transcript_session_key: str | None = None,
        reply_group_id: str | None = None,
    ) -> None:
        super().__init__(reraise=True)
        self._loop = agent_loop
        self._on_progress = on_progress
        self._on_stream = on_stream
        self._on_stream_end = on_stream_end
        self._on_tool_event = on_tool_event
        self._channel = channel
        self._chat_id = chat_id
        self._message_id = message_id
        self._stream_buf = ""
        self._transcript_session_key = transcript_session_key
        # UUID identifying the entire assistant reply for this user turn.
        # Stamped onto every transcript line (assistant tool_calls + tool
        # results + final assistant) so the UI can group multi-iteration
        # replies into one bubble in transcript replay, matching the live
        # WebSocket stream which carries the same id on each frame.
        self._reply_group_id = reply_group_id

    def wants_streaming(self) -> bool:
        return self._on_stream is not None

    async def on_stream(self, context: AgentHookContext, delta: str) -> None:
        from openpawlet.utils.helpers import strip_think

        prev_clean = strip_think(self._stream_buf)
        self._stream_buf += delta
        new_clean = strip_think(self._stream_buf)
        incremental = new_clean[len(prev_clean) :]
        if incremental and self._on_stream:
            await self._on_stream(incremental)

    async def on_stream_end(self, context: AgentHookContext, *, resuming: bool) -> None:
        if self._on_stream_end:
            await self._on_stream_end(resuming=resuming)
        self._stream_buf = ""

    async def before_iteration(self, context: AgentHookContext) -> None:
        self._loop._current_iteration = context.iteration

    async def before_execute_tools(self, context: AgentHookContext) -> None:
        if self._on_progress:
            if not self._on_stream and not context.streamed_content:
                thought = self._loop._strip_think(
                    context.response.content if context.response else None
                )
                if thought:
                    await self._on_progress(thought)
            tool_hint = self._loop._strip_think(self._loop._tool_hint(context.tool_calls))
            tool_events = [self._loop._tool_event_start_payload(tc) for tc in context.tool_calls]
            await self._loop._invoke_on_progress(
                self._on_progress,
                tool_hint,
                tool_hint=True,
                tool_events=tool_events,
            )
        if self._on_tool_event:
            await self._on_tool_event(
                tool_calls=[tc.to_openai_tool_call() for tc in context.tool_calls],
            )
        for tc in context.tool_calls:
            args_str = json.dumps(tc.arguments, ensure_ascii=False)
            logger.info("Tool call: {}({})", tc.name, args_str[:200])
        # Append the assistant-with-tool_calls message to transcript immediately
        # so in-flight tool activity is visible before the turn completes.
        self._flush_transcript_for_pending_assistant(context)
        self._loop._set_tool_context(self._channel, self._chat_id, self._message_id)

    async def after_iteration(self, context: AgentHookContext) -> None:
        if (
            self._on_progress
            and context.tool_calls
            and context.tool_events
            and self._loop._on_progress_accepts_tool_events(self._on_progress)
        ):
            tool_events = self._loop._tool_event_finish_payloads(context)
            if tool_events:
                await self._loop._invoke_on_progress(
                    self._on_progress,
                    "",
                    tool_hint=False,
                    tool_events=tool_events,
                )
        tr, tc = context.tool_results, context.tool_calls
        if tr and len(tr) == len(tc):
            tail = context.messages[-len(tr) :]
            if all(m.get("role") == "tool" for m in tail):
                if self._on_tool_event:
                    trunc = self._loop._truncate_for_tool_payload
                    await self._on_tool_event(
                        tool_results=[
                            {
                                "tool_call_id": m.get("tool_call_id"),
                                "name": m.get("name"),
                                "content": trunc(m.get("content")),
                            }
                            for m in tail
                        ]
                    )
                # Flush completed tool result messages to transcript now.
                self._flush_transcript_for_tool_results(tail)
        u = context.usage or {}
        logger.debug(
            "LLM usage: prompt={} completion={} cached={}",
            u.get("prompt_tokens", 0),
            u.get("completion_tokens", 0),
            u.get("cached_tokens", 0),
        )

    def _stamp_reply_group_id(self, message: dict[str, Any]) -> None:
        """Tag *message* with the current turn's ``reply_group_id`` if missing."""
        if not self._reply_group_id:
            return
        if message.get("reply_group_id"):
            return
        message["reply_group_id"] = self._reply_group_id

    def _flush_transcript_for_pending_assistant(self, context: AgentHookContext) -> None:
        """Append the last assistant message (carrying tool_calls) to the transcript.

        Marks the in-memory message with ``_transcript_written`` so ``_save_turn``
        skips re-appending it at turn end.
        """
        tr = getattr(self._loop, "_session_transcript", None)
        key = self._transcript_session_key
        if tr is None or not tr.enabled or not key:
            return
        msgs = context.messages
        if not msgs:
            return
        last = msgs[-1]
        if not isinstance(last, dict):
            return
        if last.get("role") != "assistant":
            return
        if last.get("_transcript_written"):
            return
        self._stamp_reply_group_id(last)
        try:
            tr.append_raw_turn_message(key, last)
        except Exception:
            logger.exception("transcript append (assistant tool_calls) failed")
            return
        last["_transcript_written"] = True

    def _flush_transcript_for_tool_results(self, tool_messages: list[dict[str, Any]]) -> None:
        """Append completed tool-result messages to the transcript immediately."""
        tr = getattr(self._loop, "_session_transcript", None)
        key = self._transcript_session_key
        if tr is None or not tr.enabled or not key:
            return
        for m in tool_messages:
            if not isinstance(m, dict):
                continue
            if m.get("_transcript_written"):
                continue
            self._stamp_reply_group_id(m)
            try:
                tr.append_raw_turn_message(key, m)
            except Exception:
                logger.exception("transcript append (tool result) failed")
                continue
            m["_transcript_written"] = True

    def finalize_content(self, context: AgentHookContext, content: str | None) -> str | None:
        return self._loop._strip_think(content)


class AgentLoop:
    """
    The agent loop is the core processing engine.

    It:
    1. Receives messages from the bus
    2. Builds context with history, memory, skills
    3. Calls the LLM
    4. Executes tool calls
    5. Sends responses back
    """

    _RUNTIME_CHECKPOINT_KEY = "runtime_checkpoint"
    _PENDING_USER_TURN_KEY = "pending_user_turn"

    def __init__(
        self,
        bus: MessageBus,
        provider: LLMProvider,
        workspace: Path,
        model: str | None = None,
        max_iterations: int | None = None,
        max_history_messages: int | None = None,
        context_window_tokens: int | None = None,
        context_block_limit: int | None = None,
        max_tool_result_chars: int | None = None,
        provider_retry_mode: str = "standard",
        web_config: WebToolsConfig | None = None,
        exec_config: ExecToolConfig | None = None,
        cron_service: CronService | None = None,
        restrict_to_workspace: bool = False,
        session_manager: SessionManager | None = None,
        mcp_servers: dict | None = None,
        channels_config: ChannelsConfig | None = None,
        timezone: str | None = None,
        session_ttl_minutes: int = 0,
        consolidation_ratio: float = 0.5,
        hooks: list[AgentHook] | None = None,
        unified_session: bool = False,
        disabled_skills: list[str] | None = None,
        console_system_prompt: str | None = None,
        tools_config: ToolsConfig | None = None,
        persist_session_transcript: bool = False,
        transcript_include_full_tool_results: bool = False,
        agent_id: str | None = None,
        agent_name: str | None = None,
        runtime_config: Config | None = None,
    ):
        from openpawlet.config.schema import (
            ChannelsConfig,
            ExecToolConfig,
            ToolsConfig,
            WebToolsConfig,
        )

        _tc = tools_config or ToolsConfig()
        defaults = AgentDefaults()
        self.bus = bus
        # Stable agent identity for the events channel.  Explicit *agent_id*
        # (in-process team members) wins; else OPENPAWLET_AGENT_ID; else main:.
        if agent_id is not None and str(agent_id).strip():
            self.agent_id = str(agent_id).strip()
        else:
            self.agent_id = (
                os.environ.get("OPENPAWLET_AGENT_ID", "").strip()
                or f"main:{_safe_nodename()}:{os.getpid()}"
            )
        if agent_name is not None and str(agent_name).strip():
            self.agent_name = str(agent_name).strip()
        else:
            self.agent_name = os.environ.get("OPENPAWLET_AGENT_NAME", "").strip()
        if not self.agent_name:
            _aid0 = (self.agent_id or "").strip()
            if _aid0 and not _aid0.startswith("main:"):
                from openpawlet.utils.console_agents import console_agent_display_name

                self.agent_name = console_agent_display_name(workspace, _aid0)
        self.channels_config = channels_config or ChannelsConfig()
        self._session_turn_lifecycle_channels = frozenset(
            self.channels_config.session_turn_lifecycle_channels
        )
        self.provider = provider
        self.workspace = workspace
        self.model = model or provider.get_default_model()
        self.max_iterations = (
            max_iterations if max_iterations is not None else defaults.max_tool_iterations
        )
        self.max_history_messages = (
            max_history_messages
            if max_history_messages is not None
            else defaults.max_history_messages
        )
        self.context_window_tokens = (
            context_window_tokens
            if context_window_tokens is not None
            else defaults.context_window_tokens
        )
        self.context_block_limit = context_block_limit
        self.max_tool_result_chars = (
            max_tool_result_chars
            if max_tool_result_chars is not None
            else defaults.max_tool_result_chars
        )
        self.provider_retry_mode = provider_retry_mode
        self.web_config = web_config or WebToolsConfig()
        self.exec_config = exec_config or ExecToolConfig()
        self.cron_service = cron_service
        self.restrict_to_workspace = restrict_to_workspace
        self._start_time = time.time()
        self._last_usage: dict[str, int] = {}
        self._extra_hooks: list[AgentHook] = hooks or []

        self.timezone = timezone
        _extra_sys: list[str] | None = None
        if console_system_prompt and str(console_system_prompt).strip():
            _extra_sys = [f"# Console agent instructions\n\n{str(console_system_prompt).strip()}"]
        self.context = ContextBuilder(
            workspace,
            timezone=self.timezone,
            disabled_skills=disabled_skills,
            extra_system_sections=_extra_sys,
        )
        self.sessions = session_manager or SessionManager(workspace, timezone=self.timezone)
        self.sessions.configure_timezone(self.timezone)
        self.tools = ToolRegistry()
        self.runner = AgentRunner(provider)
        # Build the transcript writer up-front so it can be shared with the
        # sub-agent manager (lets sub-agents persist their own conversation
        # under ``transcripts/subagent_<parent>_<task_id>.jsonl``).
        self._session_transcript: SessionTranscriptWriter | None = None
        if persist_session_transcript:
            self._session_transcript = SessionTranscriptWriter(
                workspace,
                enabled=True,
                include_full_tool_results=transcript_include_full_tool_results,
                max_tool_result_chars=self.max_tool_result_chars,
                timezone=self.timezone,
            )
        self.subagents = SubagentManager(
            provider=provider,
            workspace=workspace,
            bus=bus,
            model=self.model,
            web_config=self.web_config,
            max_tool_result_chars=self.max_tool_result_chars,
            exec_config=self.exec_config,
            restrict_to_workspace=restrict_to_workspace,
            disabled_skills=disabled_skills,
            timezone=self.timezone,
            parent_agent_id=self.agent_id,
            base_defaults=(
                runtime_config.agents.defaults if runtime_config is not None else None
            ),
            base_tools=_tc,
            transcript_writer=self._session_transcript,
            session_manager=self.sessions,
            max_iterations=self.max_iterations,
        )
        self._unified_session = unified_session
        self._running = False
        self._mcp_servers = mcp_servers or {}
        self._mcp_stacks: dict[str, AsyncExitStack] = {}
        self._mcp_connected = False
        self._mcp_connecting = False
        self._active_tasks: dict[str, list[asyncio.Task]] = {}  # session_key -> tasks
        self._background_tasks: list[asyncio.Task] = []
        self._session_locks: dict[str, asyncio.Lock] = {}
        # Per-session pending queues for mid-turn message injection.
        # When a session has an active task, new messages for that session
        # are routed here instead of creating a new task.
        self._pending_queues: dict[str, asyncio.Queue] = {}
        # OPENPAWLET_MAX_CONCURRENT_REQUESTS: <=0 means unlimited; default 3.
        _max = int(os.environ.get("OPENPAWLET_MAX_CONCURRENT_REQUESTS", "3"))
        self._concurrency_gate: asyncio.Semaphore | None = (
            asyncio.Semaphore(_max) if _max > 0 else None
        )
        self.consolidator = Consolidator(
            store=self.context.memory,
            provider=provider,
            model=self.model,
            sessions=self.sessions,
            context_window_tokens=self.context_window_tokens,
            build_messages=self.context.build_messages,
            get_tool_definitions=self.tools.get_definitions,
            max_completion_tokens=provider.generation.max_tokens,
            consolidation_ratio=consolidation_ratio,
        )
        # Per-turn snapshot of the real assembled LLM context (system prompt +
        # messages sent to the provider). Written to ``context/{key}.jsonl`` so
        # the console can show exactly what the agent saw on every turn.
        self._session_context_writer = SessionContextWriter(
            workspace,
            enabled=True,
            timezone=self.timezone,
        )
        self._session_turn_counters: dict[str, int] = {}
        self.auto_compact = AutoCompact(
            sessions=self.sessions,
            consolidator=self.consolidator,
            session_ttl_minutes=session_ttl_minutes,
            transcript=self._session_transcript,
        )
        self.dream = Dream(
            store=self.context.memory,
            provider=provider,
            model=self.model,
        )
        self._register_default_tools()
        if _tc.my.enable:
            self.tools.register(MyTool(loop=self, modify_allowed=_tc.my.allow_set))
        self._runtime_vars: dict[str, Any] = {}
        self._pending_cron_capture: tuple[dict[str, Any], str] | None = None
        self._current_iteration: int = 0
        self.commands = CommandRouter()
        register_builtin_commands(self.commands)
        # console:team_* session keys -> in-process member AgentLoop (gateway only)
        self.team_session_dispatch: dict[str, AgentLoop] | None = None
        # Hot-reload console team/agent JSON without process restart (gateway only).
        self._runtime_config = runtime_config
        self._identity_state_max_mtime: float = -1.0
        if self._runtime_config is not None:
            self._identity_state_max_mtime = self._compute_identity_sources_mtime()

    def _sync_subagent_runtime_limits(self) -> None:
        """Keep subagent runtime limits aligned with mutable loop settings."""
        self.subagents.max_iterations = self.max_iterations

    def _logical_agent_id_for_console_row(self) -> str | None:
        """Same resolution as gateway startup: env OPENPAWLET_AGENT_ID, else non-synthetic agent_id."""
        env_aid = os.environ.get("OPENPAWLET_AGENT_ID", "").strip()
        if env_aid:
            return env_aid
        aid = (self.agent_id or "").strip()
        if aid.startswith("main:"):
            return None
        return aid or None

    def _compute_identity_sources_mtime(self) -> float:
        """Max mtime of files that feed :func:`resolve_gateway_identity_overrides`."""
        w = self.workspace
        t = 0.0
        nc = workspace_console_subdir(w)
        for name in ("teams.json", "active_team_gateway.json"):
            f = nc / name
            if f.is_file():
                try:
                    t = max(t, f.stat().st_mtime)
                except OSError:
                    pass
        aid = self._logical_agent_id_for_console_row()
        if aid:
            one = w / "agents" / f"{aid}.json"
            if one.is_file():
                try:
                    t = max(t, one.stat().st_mtime)
                except OSError:
                    pass
            else:
                legacy = nc / "agents.json"
                if legacy.is_file():
                    try:
                        t = max(t, legacy.stat().st_mtime)
                    except OSError:
                        pass
        return t

    def _maybe_refresh_gateway_identity(self) -> None:
        """Re-read console team/agent JSON when files change (gateway with ``runtime_config``)."""
        if self._runtime_config is None:
            return
        cur = self._compute_identity_sources_mtime()
        if cur <= self._identity_state_max_mtime:
            return
        self._identity_state_max_mtime = cur
        from openpawlet.utils.console_agents import resolve_gateway_identity_overrides
        from openpawlet.utils.team_gateway_runtime import resolve_gateway_team_context

        tid, _, _ = resolve_gateway_team_context(self.workspace)
        _m, ds, prompt = resolve_gateway_identity_overrides(
            self._runtime_config,
            self.workspace,
            logical_agent_id=self._logical_agent_id_for_console_row(),
            team_id=tid,
        )
        _ = _m  # model is resolved at process start; hot path updates skills + prompt only
        _extra: list[str] = []
        if prompt and str(prompt).strip():
            _extra = [f"# Console agent instructions\n\n{str(prompt).strip()}"]
        self.context.apply_skills_and_extra_prompt(
            disabled_skills=ds,
            extra_system_sections=_extra,
        )
        self.subagents.disabled_skills = set(ds or [])
        self.consolidator._build_messages = self.context.build_messages

    @property
    def session_transcript(self) -> SessionTranscriptWriter | None:
        """Optional append-only verbatim transcript writer (see persist_session_transcript)."""
        return getattr(self, "_session_transcript", None)

    def apply_hot_config(self, new_config: Config) -> dict[str, Any]:
        """Apply config changes that can be hot-swapped without rebuilding the loop.

        In-flight requests keep their captured field references; only new
        turns / sessions started after this call see the new values. Returns
        a mapping describing what was actually changed (mostly for logs and
        tests).

        Fields that are NOT hot-swappable (channels, mcp_servers, web/exec
        tools, restrict_to_workspace, provider plumbing) are intentionally
        ignored here — callers route those through ``swap_runtime`` instead.
        """
        defaults = new_config.agents.defaults
        changed: dict[str, Any] = {}

        new_model = defaults.model or self.provider.get_default_model()
        if new_model != self.model:
            changed["model"] = (self.model, new_model)
            self.model = new_model
            self.consolidator.model = new_model
            self.dream.model = new_model
            try:
                self.subagents.model = new_model
            except AttributeError:
                pass

        if defaults.timezone != self.timezone:
            changed["timezone"] = (self.timezone, defaults.timezone)
            self.timezone = defaults.timezone
            self.context.timezone = defaults.timezone
            self.sessions.configure_timezone(defaults.timezone)
            try:
                self.subagents.timezone = defaults.timezone
            except AttributeError:
                pass

        if defaults.max_tool_iterations != self.max_iterations:
            changed["max_iterations"] = (self.max_iterations, defaults.max_tool_iterations)
            self.max_iterations = defaults.max_tool_iterations
            self._sync_subagent_runtime_limits()

        if defaults.max_history_messages != self.max_history_messages:
            changed["max_history_messages"] = (
                self.max_history_messages,
                defaults.max_history_messages,
            )
            self.max_history_messages = defaults.max_history_messages

        if defaults.max_tool_result_chars != self.max_tool_result_chars:
            changed["max_tool_result_chars"] = (
                self.max_tool_result_chars,
                defaults.max_tool_result_chars,
            )
            self.max_tool_result_chars = defaults.max_tool_result_chars

        if defaults.context_window_tokens != self.context_window_tokens:
            changed["context_window_tokens"] = (
                self.context_window_tokens,
                defaults.context_window_tokens,
            )
            self.context_window_tokens = defaults.context_window_tokens
            self.consolidator.context_window_tokens = defaults.context_window_tokens

        if defaults.context_block_limit != self.context_block_limit:
            changed["context_block_limit"] = (
                self.context_block_limit,
                defaults.context_block_limit,
            )
            self.context_block_limit = defaults.context_block_limit

        if defaults.provider_retry_mode != self.provider_retry_mode:
            changed["provider_retry_mode"] = (
                self.provider_retry_mode,
                defaults.provider_retry_mode,
            )
            self.provider_retry_mode = defaults.provider_retry_mode

        new_disabled = set(defaults.disabled_skills or [])
        cur_disabled = set(getattr(self.context.skills, "disabled_skills", set()) or set())
        if new_disabled != cur_disabled:
            changed["disabled_skills"] = sorted(new_disabled)
            self.context.apply_skills_and_extra_prompt(
                disabled_skills=sorted(new_disabled),
                extra_system_sections=None,
            )

        if defaults.session_ttl_minutes != getattr(self.auto_compact, "_ttl", None):
            changed["session_ttl_minutes"] = defaults.session_ttl_minutes
            self.auto_compact._ttl = defaults.session_ttl_minutes

        return changed

    def replace_provider(
        self, new_provider: LLMProvider, *, new_model: str | None = None
    ) -> None:
        """Swap the LLM provider used by every downstream component.

        Used when ``llm_providers.json`` changes the active default
        instance or rotates an API key. In-flight LLM calls keep their
        bound provider; only new calls go through the replacement.

        ``new_model`` is honored when the previously bound provider was
        the placeholder :class:`NullProvider` (or any provider whose
        default model the loop captured at construction time but no
        longer matches the configured one): without re-syncing
        ``self.model`` the agent would keep sending requests against the
        placeholder name even after a real provider became available.
        """
        previous_model = self.model
        self.provider = new_provider
        self.runner.provider = new_provider
        self.consolidator.provider = new_provider
        self.dream.provider = new_provider
        try:
            self.subagents.provider = new_provider
        except AttributeError:
            pass

        if new_model:
            target_model = new_model
        else:
            try:
                target_model = new_provider.get_default_model()
            except Exception:  # pragma: no cover - provider must always supply one
                target_model = previous_model

        if target_model and target_model != previous_model:
            self.model = target_model
            # Dream is the only sub-component that captures its own
            # model field at construction time (see EmbeddedOpenPawlet).
            # Only realign it when it was tracking the loop's previous
            # model — never overwrite an explicit ``dream.model_override``.
            try:
                if getattr(self.dream, "model", None) in (None, previous_model):
                    self.dream.model = target_model
            except AttributeError:
                pass

    def _snapshot_turn_context(
        self,
        session_key: str | None,
        messages: list[dict[str, Any]],
        *,
        channel: str | None,
        chat_id: str | None,
        source: str = "agent_turn",
    ) -> None:
        """Persist the latest assembled context for *session_key*.

        The writer overwrites ``context/{key}.jsonl`` on every turn so the
        on-disk file always reflects the most recent prompt sent to the LLM
        without growing unbounded.  ``turn_index`` is kept as a best-effort
        counter so the UI can still show how many turns have been recorded in
        this process lifetime.  Failures are swallowed to avoid breaking the
        agent turn on transient IO errors.
        """
        writer = getattr(self, "_session_context_writer", None)
        if writer is None or not writer.enabled or not session_key or not messages:
            return
        counter = self._session_turn_counters.get(session_key, 0) + 1
        self._session_turn_counters[session_key] = counter
        try:
            writer.write_snapshot(
                session_key,
                messages=messages,
                channel=channel,
                chat_id=chat_id,
                turn_index=counter,
                source=source,
            )
        except Exception:
            logger.exception("Failed to write context snapshot for session {}", session_key)

    def _register_default_tools(self) -> None:
        """Register the default set of tools."""
        allowed_dir = (
            self.workspace if (self.restrict_to_workspace or self.exec_config.sandbox) else None
        )
        extra_read = [BUILTIN_SKILLS_DIR] if allowed_dir else None
        self.tools.register(
            ReadFileTool(
                workspace=self.workspace, allowed_dir=allowed_dir, extra_allowed_dirs=extra_read
            )
        )
        for cls in (WriteFileTool, EditFileTool, ListDirTool):
            self.tools.register(cls(workspace=self.workspace, allowed_dir=allowed_dir))
        for cls in (GlobTool, GrepTool):
            self.tools.register(cls(workspace=self.workspace, allowed_dir=allowed_dir))
        self.tools.register(NotebookEditTool(workspace=self.workspace, allowed_dir=allowed_dir))
        if self.exec_config.enable:
            self.tools.register(
                ExecTool(
                    working_dir=str(self.workspace),
                    timeout=self.exec_config.timeout,
                    restrict_to_workspace=self.restrict_to_workspace,
                    sandbox=self.exec_config.sandbox,
                    path_append=self.exec_config.path_append,
                    allowed_env_keys=self.exec_config.allowed_env_keys,
                )
            )
        if self.web_config.enable:
            _ua = self.web_config.user_agent
            self.tools.register(
                WebSearchTool(config=self.web_config.search, proxy=self.web_config.proxy, user_agent=_ua)
            )
            self.tools.register(
                WebFetchTool(
                    config=self.web_config.fetch,
                    proxy=self.web_config.proxy,
                    user_agent=_ua,
                )
            )
        self.tools.register(MessageTool(send_callback=self.bus.publish_outbound))
        self.tools.register(AskUserTool())
        self.tools.register(SpawnTool(manager=self.subagents))
        # Events tools: agent-to-agent / pub-sub.  SubscribeEventTool
        # forwards background events to the loop as InboundMessage so the
        # agent can react on its next turn without blocking the current one.
        self.tools.register(PublishEventTool(bus=self.bus, default_source_agent=self.agent_id))
        self.tools.register(SendToAgentTool(bus=self.bus, default_source_agent=self.agent_id))
        self.tools.register(
            SendToAgentWaitReplyTool(bus=self.bus, default_source_agent=self.agent_id)
        )
        self.tools.register(
            ReplyToAgentRequestTool(bus=self.bus, default_source_agent=self.agent_id)
        )
        self.tools.register(
            SubscribeEventTool(
                bus=self.bus,
                default_agent_id=self.agent_id,
                default_agent_name=self.agent_name,
                inject_inbound=self.bus.publish_inbound,
            )
        )
        self.tools.register(ListEventSubscribersTool(bus=self.bus))
        if self.cron_service:
            self.tools.register(
                CronTool(self.cron_service, default_timezone=self.timezone or "UTC")
            )

    async def _connect_mcp(self) -> None:
        """Connect to configured MCP servers (one-time, lazy)."""
        if self._mcp_connected or self._mcp_connecting or not self._mcp_servers:
            return
        self._mcp_connecting = True
        from openpawlet.agent.tools.mcp import connect_mcp_servers

        try:
            self._mcp_stacks = await connect_mcp_servers(self._mcp_servers, self.tools)
            if self._mcp_stacks:
                self._mcp_connected = True
            else:
                logger.warning("No MCP servers connected successfully (will retry next message)")
        except asyncio.CancelledError:
            logger.warning("MCP connection cancelled (will retry next message)")
            self._mcp_stacks.clear()
        except BaseException as e:
            logger.error("Failed to connect MCP servers (will retry next message): {}", e)
            self._mcp_stacks.clear()
        finally:
            self._mcp_connecting = False

    def _set_tool_context(self, channel: str, chat_id: str, message_id: str | None = None) -> None:
        """Update context for all tools that need routing info."""
        # Compute the effective session key (accounts for unified sessions)
        # so that subagent results route to the correct pending queue.
        effective_key = UNIFIED_SESSION_KEY if self._unified_session else f"{channel}:{chat_id}"
        cron_meta: dict[str, Any] = {}
        cron_sess = ""
        if self._pending_cron_capture:
            cron_meta, cron_sess = self._pending_cron_capture
        cron_session_resolved = (
            cron_sess.strip() if isinstance(cron_sess, str) and cron_sess.strip() else effective_key
        )
        for name in ("message", "spawn", "cron", "my"):
            if tool := self.tools.get(name):
                if hasattr(tool, "set_context"):
                    if name == "spawn":
                        tool.set_context(channel, chat_id, effective_key=effective_key)
                    elif name == "cron":
                        tool.set_context(
                            channel,
                            chat_id,
                            metadata=cron_meta or None,
                            session_key=cron_session_resolved,
                        )
                    else:
                        tool.set_context(
                            channel, chat_id, *([message_id] if name == "message" else [])
                        )
        # Event tools follow a different signature (agent_id-aware) so
        # they get their own configuration pass.
        for name in (
            "publish_event",
            "send_to_agent",
            "send_to_agent_wait_reply",
            "reply_to_agent_request",
        ):
            if (tool := self.tools.get(name)) and hasattr(tool, "set_context"):
                tool.set_context(
                    source_agent=self.agent_id,
                    source_session_key=effective_key,
                )
        if (sub_tool := self.tools.get("subscribe_event")) and hasattr(sub_tool, "set_context"):
            sub_tool.set_context(
                agent_id=self.agent_id,
                session_key=effective_key,
                channel=channel,
                chat_id=chat_id,
            )

    @staticmethod
    def _strip_think(text: str | None) -> str | None:
        """Remove <think>…</think> blocks that some models embed in content."""
        if not text:
            return None
        from openpawlet.utils.helpers import strip_think

        return strip_think(text) or None

    @staticmethod
    def _tool_hint(tool_calls: list) -> str:
        """Format tool calls as concise hints with smart abbreviation."""
        from openpawlet.utils.tool_hints import format_tool_hints

        return format_tool_hints(tool_calls)

    def _truncate_for_tool_payload(self, content: Any) -> str:
        """Bound tool result size for tool_event metadata (string or JSON-serialized)."""
        max_chars = min(65_536, max(4_096, self.max_tool_result_chars))
        if isinstance(content, str):
            return truncate_text_fn(content, max_chars)
        try:
            text = json.dumps(content, ensure_ascii=False)
        except (TypeError, ValueError):
            text = str(content)
        return truncate_text_fn(text, max_chars)

    async def _dispatch_command_inline(
        self,
        msg: InboundMessage,
        key: str,
        raw: str,
        dispatch_fn: Callable[[CommandContext], Awaitable[OutboundMessage | None]],
    ) -> None:
        """Dispatch a command directly from the run() loop and publish the result."""
        ctx = CommandContext(msg=msg, session=None, key=key, raw=raw, loop=self)
        result = await dispatch_fn(ctx)
        if result:
            await self.bus.publish_outbound(result)
        else:
            logger.warning("Command '{}' matched but dispatch returned None", raw)

    async def _cancel_active_tasks(self, key: str) -> int:
        """Cancel and await all active tasks and subagents for *key*.

        Returns the total number of cancelled tasks + subagents.
        """
        tasks = self._active_tasks.pop(key, [])
        cancelled = sum(1 for t in tasks if not t.done() and t.cancel())
        for t in tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        sub_cancelled = await self.subagents.cancel_by_session(key)
        return cancelled + sub_cancelled

    @staticmethod
    def _on_progress_accepts_tool_events(cb: Callable[..., Any]) -> bool:
        try:
            sig = inspect.signature(cb)
        except (TypeError, ValueError):
            return False
        if any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()):
            return True
        return "tool_events" in sig.parameters

    @staticmethod
    async def _invoke_on_progress(
        on_progress: Callable[..., Awaitable[None]],
        content: str,
        *,
        tool_hint: bool = False,
        tool_events: list[dict[str, Any]] | None = None,
    ) -> None:
        if tool_events and AgentLoop._on_progress_accepts_tool_events(on_progress):
            await on_progress(content, tool_hint=tool_hint, tool_events=tool_events)
        else:
            await on_progress(content, tool_hint=tool_hint)

    @staticmethod
    def _tool_event_start_payload(tool_call: Any) -> dict[str, Any]:
        return {
            "version": 1,
            "phase": "start",
            "call_id": str(getattr(tool_call, "id", "") or ""),
            "name": getattr(tool_call, "name", ""),
            "arguments": getattr(tool_call, "arguments", {}) or {},
            "result": None,
            "error": None,
            "files": [],
            "embeds": [],
        }

    @staticmethod
    def _tool_event_result_extras(result: Any) -> tuple[list[Any], list[Any]]:
        if not isinstance(result, dict):
            return [], []
        files = result.get("files") if isinstance(result.get("files"), list) else []
        embeds = result.get("embeds") if isinstance(result.get("embeds"), list) else []
        return files, embeds

    @classmethod
    def _tool_event_finish_payloads(cls, context: AgentHookContext) -> list[dict[str, Any]]:
        payloads: list[dict[str, Any]] = []
        count = min(len(context.tool_calls), len(context.tool_results), len(context.tool_events))
        for idx in range(count):
            tool_call = context.tool_calls[idx]
            result = context.tool_results[idx]
            event = context.tool_events[idx] if isinstance(context.tool_events[idx], dict) else {}
            status = event.get("status")
            phase = "end" if status == "ok" else "error"
            files, embeds = cls._tool_event_result_extras(result)
            payload = {
                "version": 1,
                "phase": phase,
                "call_id": str(getattr(tool_call, "id", "") or ""),
                "name": getattr(tool_call, "name", ""),
                "arguments": getattr(tool_call, "arguments", {}) or {},
                "result": result if phase == "end" else None,
                "error": None,
                "files": files,
                "embeds": embeds,
            }
            if phase == "error":
                if isinstance(result, str) and result.strip():
                    payload["error"] = result.strip()
                else:
                    payload["error"] = str(event.get("detail") or "Tool execution failed")
            payloads.append(payload)
        return payloads

    def _effective_session_key(self, msg: InboundMessage) -> str:
        """Return the session key used for task routing and mid-turn injections."""
        if self._unified_session and not msg.session_key_override:
            return UNIFIED_SESSION_KEY
        return msg.session_key

    def is_session_busy(self, session_key: str) -> bool:
        """True while the loop is actively running :meth:`_dispatch` for *session_key*.

        The session is registered in :attr:`_pending_queues` for the full duration of
        an inbound turn (LLM + tools), so this reflects server-side \"assistant is
        working\" even when no WebSocket client is connected (e.g. user left the page).

        If ``agents.defaults.unified_session`` is enabled, routing uses
        :data:`UNIFIED_SESSION_KEY` instead of per-chat keys; callers must query that
        key (or disable unified session for per-chat console UX).
        """
        sk = (session_key or "").strip()
        if not sk:
            return False
        return sk in self._pending_queues

    async def _run_agent_loop(
        self,
        initial_messages: list[dict],
        on_progress: Callable[..., Awaitable[None]] | None = None,
        on_stream: Callable[[str], Awaitable[None]] | None = None,
        on_stream_end: Callable[..., Awaitable[None]] | None = None,
        on_retry_wait: Callable[[str], Awaitable[None]] | None = None,
        on_tool_event: Callable[..., Awaitable[None]] | None = None,
        *,
        session: Session | None = None,
        channel: str = "cli",
        chat_id: str = "direct",
        message_id: str | None = None,
        pending_queue: asyncio.Queue | None = None,
        reply_group_id: str | None = None,
    ) -> tuple[str | None, list[str], list[dict], str, bool]:
        """Run the agent iteration loop.

        *on_stream*: called with each content delta during streaming.
        *on_stream_end(resuming)*: called when a streaming session finishes.
        ``resuming=True`` means tool calls follow (spinner should restart);
        ``resuming=False`` means this is the final response.
        *on_tool_event*: optional ``tool_calls`` / ``tool_results`` callback (e.g. WebSocket).

        Returns (final_content, tools_used, messages, stop_reason, had_injections).
        """
        self._sync_subagent_runtime_limits()

        loop_hook = _LoopHook(
            self,
            on_progress=on_progress,
            on_stream=on_stream,
            on_stream_end=on_stream_end,
            on_tool_event=on_tool_event,
            channel=channel,
            chat_id=chat_id,
            message_id=message_id,
            transcript_session_key=session.key if session else None,
            reply_group_id=reply_group_id,
        )
        hook: AgentHook = (
            CompositeHook([loop_hook] + self._extra_hooks) if self._extra_hooks else loop_hook
        )

        async def _checkpoint(payload: dict[str, Any]) -> None:
            if session is None:
                return
            self._set_runtime_checkpoint(session, payload)

        async def _drain_pending(*, limit: int = _MAX_INJECTIONS_PER_TURN) -> list[dict[str, Any]]:
            """Drain follow-up messages from the pending queue.

            When no messages are immediately available but sub-agents
            spawned in this dispatch are still running, blocks until at
            least one result arrives (or timeout).  This keeps the runner
            loop alive so subsequent sub-agent completions are consumed
            in-order rather than dispatched separately.
            """
            if pending_queue is None:
                return []

            def _to_user_message(pending_msg: InboundMessage) -> dict[str, Any]:
                content = pending_msg.content
                media = pending_msg.media if pending_msg.media else None
                if media:
                    content, media = extract_documents(content, media)
                    media = media or None
                user_content = self.context._build_user_content(content, media)
                runtime_ctx = self.context._build_runtime_context(
                    pending_msg.channel,
                    pending_msg.chat_id,
                    self.timezone,
                )
                if isinstance(user_content, str):
                    merged: str | list[dict[str, Any]] = f"{runtime_ctx}\n\n{user_content}"
                else:
                    merged = [{"type": "text", "text": runtime_ctx}] + user_content
                return {"role": "user", "content": merged}

            items: list[dict[str, Any]] = []
            while len(items) < limit:
                try:
                    items.append(_to_user_message(pending_queue.get_nowait()))
                except asyncio.QueueEmpty:
                    break

            # Block if nothing drained but sub-agents spawned in this dispatch
            # are still running.  Keeps the runner loop alive so subsequent
            # completions are injected in-order rather than dispatched separately.
            if (
                not items
                and session is not None
                and self.subagents.get_running_count_by_session(session.key) > 0
            ):
                try:
                    msg = await asyncio.wait_for(pending_queue.get(), timeout=300)
                except TimeoutError:
                    logger.warning(
                        "Timeout waiting for sub-agent completion in session {}",
                        session.key,
                    )
                    return items
                items.append(_to_user_message(msg))
                while len(items) < limit:
                    try:
                        items.append(_to_user_message(pending_queue.get_nowait()))
                    except asyncio.QueueEmpty:
                        break

            return items

        result = await self.runner.run(
            AgentRunSpec(
                initial_messages=initial_messages,
                tools=self.tools,
                model=self.model,
                max_iterations=self.max_iterations,
                max_tool_result_chars=self.max_tool_result_chars,
                hook=hook,
                error_message="Sorry, I encountered an error calling the AI model.",
                concurrent_tools=True,
                workspace=self.workspace,
                session_key=session.key if session else None,
                context_window_tokens=self.context_window_tokens,
                context_block_limit=self.context_block_limit,
                provider_retry_mode=self.provider_retry_mode,
                progress_callback=on_progress,
                retry_wait_callback=on_retry_wait,
                checkpoint_callback=_checkpoint,
                injection_callback=_drain_pending,
            )
        )
        self._last_usage = result.usage
        if result.stop_reason == "max_iterations":
            logger.warning("Max iterations ({}) reached", self.max_iterations)
            # Push final content through stream so streaming channels (e.g. Feishu)
            # update the card instead of leaving it empty.
            if on_stream and on_stream_end:
                await on_stream(result.final_content or "")
                await on_stream_end(resuming=False)
        elif result.stop_reason == "error":
            logger.error("LLM returned error: {}", (result.final_content or "")[:200])
        return (
            result.final_content,
            result.tools_used,
            result.messages,
            result.stop_reason,
            result.had_injections,
        )

    async def _install_team_event_tap(self) -> None:
        """If ``OPENPAWLET_TEAM_SESSION_KEY`` is set, install background bus subscription."""
        if os.environ.get("OPENPAWLET_TEAM_IN_PROCESS", "").strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }:
            return
        key = os.environ.get("OPENPAWLET_TEAM_SESSION_KEY", "").strip()
        if not key:
            return
        if os.environ.get("OPENPAWLET_TEAM_EVENT_SUBSCRIBE", "1").strip().lower() in {
            "0",
            "false",
            "no",
            "off",
        }:
            return
        sub = self.tools.get("subscribe_event")
        if not isinstance(sub, SubscribeEventTool):
            return
        before, _, after = key.partition(":")
        channel = before if after else "console"
        chat_id = after if after else key
        sub.set_context(
            agent_id=self.agent_id,
            session_key=key,
            channel=channel,
            chat_id=chat_id,
        )
        for name in (
            "publish_event",
            "send_to_agent",
            "send_to_agent_wait_reply",
            "reply_to_agent_request",
        ):
            t = self.tools.get(name)
            if t is not None and hasattr(t, "set_context"):
                t.set_context(
                    source_agent=self.agent_id,
                    source_session_key=key,
                )
        try:
            out = await sub.execute(topics=[])
            logger.info("Team session subscribe_event: {}", (out or "")[:300])
        except Exception:
            logger.exception("Team session subscribe_event failed")

    def _dispatch_target_for_message(self, msg: InboundMessage) -> tuple[AgentLoop, str]:
        """Return (loop, effective_session_key) for routing inbound user traffic."""
        eff = self._effective_session_key(msg)
        td = self.team_session_dispatch
        if td:
            member = td.get(eff)
            if member is not None:
                return member, member._effective_session_key(msg)
            # Reconciliation lag can briefly leave a brand-new room session key
            # out of dispatch map. Fall back to member loop by agent_id.
            match = _TEAM_SESSION_KEY_WITH_AGENT_RE.match(eff)
            if match:
                agent_id = match.group("agent_id")
                for loop in set(td.values()):
                    if (loop.agent_id or "").strip() == agent_id:
                        return loop, loop._effective_session_key(msg)
        if _TEAM_SESSION_KEY_RE.match(eff):
            logger.warning("team session key not registered in dispatch map: {}", eff)
        return self, eff

    async def run(self) -> None:
        """Run the agent loop, dispatching messages as tasks to stay responsive to /stop."""
        self._running = True
        await self._connect_mcp()
        await self._install_team_event_tap()
        logger.info("Agent loop started")

        while self._running:
            try:
                msg = await asyncio.wait_for(self.bus.consume_inbound(), timeout=1.0)
            except TimeoutError:
                self.auto_compact.check_expired(
                    self._schedule_background,
                    active_session_keys=self._pending_queues.keys(),
                )
                continue
            except asyncio.CancelledError:
                # Preserve real task cancellation so shutdown can complete cleanly.
                # Only ignore non-task CancelledError signals that may leak from integrations.
                if not self._running or asyncio.current_task().cancelling():
                    raise
                continue
            except Exception as e:
                logger.warning("Error consuming inbound message: {}, continuing...", e)
                continue

            raw = msg.content.strip()
            target, effective_key = self._dispatch_target_for_message(msg)
            if target.commands.is_priority(raw):
                await target._dispatch_command_inline(
                    msg,
                    effective_key,
                    raw,
                    target.commands.dispatch_priority,
                )
                continue
            # If this session already has an active pending queue (i.e. a task
            # is processing this session), route the message there for mid-turn
            # injection instead of creating a competing task.
            if effective_key in target._pending_queues:
                # Non-priority commands must not be queued for injection;
                # dispatch them directly (same pattern as priority commands).
                if target.commands.is_dispatchable_command(raw):
                    await target._dispatch_command_inline(
                        msg,
                        effective_key,
                        raw,
                        target.commands.dispatch,
                    )
                    continue
                pending_msg = msg
                if effective_key != msg.session_key:
                    pending_msg = dataclasses.replace(
                        msg,
                        session_key_override=effective_key,
                    )
                try:
                    target._pending_queues[effective_key].put_nowait(pending_msg)
                except asyncio.QueueFull:
                    logger.warning(
                        "Pending queue full for session {}, falling back to queued task",
                        effective_key,
                    )
                else:
                    logger.info(
                        "Routed follow-up message to pending queue for session {}",
                        effective_key,
                    )
                    continue
            # Compute the effective session key before dispatching
            # This ensures /stop command can find tasks correctly when unified session is enabled
            task = asyncio.create_task(target._dispatch(msg))
            target._active_tasks.setdefault(effective_key, []).append(task)
            task.add_done_callback(
                lambda t, k=effective_key, tgt=target: (
                    tgt._active_tasks.get(k, []) and tgt._active_tasks[k].remove(t)
                    if t in tgt._active_tasks.get(k, [])
                    else None
                )
            )

    async def _publish_session_turn_lifecycle(self, msg: InboundMessage, *, phase: str) -> None:
        """Notify channel that an agent turn is starting or finished (wire protocol specific)."""
        meta = dict(msg.metadata or {})
        meta["_session_turn_event"] = phase
        await self.bus.publish_outbound(
            OutboundMessage(
                channel=msg.channel,
                chat_id=msg.chat_id,
                content="",
                metadata=meta,
            )
        )

    async def _dispatch(self, msg: InboundMessage) -> None:
        """Process a message: per-session serial, cross-session concurrent."""
        session_key = self._effective_session_key(msg)
        if session_key != msg.session_key:
            msg = dataclasses.replace(msg, session_key_override=session_key)
        lock = self._session_locks.setdefault(session_key, asyncio.Lock())
        gate = self._concurrency_gate or nullcontext()

        # Register a pending queue so follow-up messages for this session are
        # routed here (mid-turn injection) instead of spawning a new task.
        pending = asyncio.Queue(maxsize=20)
        self._pending_queues[session_key] = pending

        try:
            async with lock, gate:
                turn_lifecycle = msg.channel in self._session_turn_lifecycle_channels
                turn_id = str(uuid.uuid4())
                # ``reply_group_id`` is the canonical UUID used to group the
                # entire assistant reply for one user turn. It is stamped onto
                # every WebSocket frame and transcript line emitted during the
                # turn so the UI can render multi-iteration replies as one
                # bubble both live and on transcript replay.
                reply_group_id = turn_id
                inbound_meta = dict(msg.metadata or {})
                if not inbound_meta.get("reply_group_id"):
                    inbound_meta["reply_group_id"] = reply_group_id
                else:
                    reply_group_id = str(inbound_meta["reply_group_id"])
                if inbound_meta != (msg.metadata or {}):
                    msg = dataclasses.replace(msg, metadata=inbound_meta)
                t0 = time.perf_counter()
                outcome = "ok"
                with logger.contextualize(
                    turn_id=turn_id,
                    session_key=session_key,
                    channel=msg.channel,
                    chat_id=msg.chat_id,
                    sender=msg.sender_id,
                ):
                    if turn_lifecycle:
                        await self._publish_session_turn_lifecycle(msg, phase="start")
                    try:
                        on_stream = on_stream_end = None
                        if msg.metadata.get("_wants_stream"):
                            # Split one answer into distinct stream segments.
                            stream_base_id = f"{msg.session_key}:{time.time_ns()}"
                            stream_segment = 0

                            def _current_stream_id() -> str:
                                return f"{stream_base_id}:{stream_segment}"

                            async def on_stream(delta: str) -> None:
                                await self.bus.publish_outbound(
                                    _reply_to(
                                        msg,
                                        delta,
                                        extra_metadata={
                                            "_stream_delta": True,
                                            "_stream_id": _current_stream_id(),
                                        },
                                    )
                                )

                            async def on_stream_end(*, resuming: bool = False) -> None:
                                nonlocal stream_segment
                                await self.bus.publish_outbound(
                                    _reply_to(
                                        msg,
                                        "",
                                        extra_metadata={
                                            "_stream_end": True,
                                            "_resuming": resuming,
                                            "_stream_id": _current_stream_id(),
                                        },
                                    )
                                )
                                stream_segment += 1

                        response = await self._process_message(
                            msg,
                            on_stream=on_stream,
                            on_stream_end=on_stream_end,
                            pending_queue=pending,
                        )
                        if response is not None:
                            await self.bus.publish_outbound(response)
                        elif msg.channel == "cli":
                            await self.bus.publish_outbound(
                                OutboundMessage(
                                    channel=msg.channel,
                                    chat_id=msg.chat_id,
                                    content="",
                                    metadata=msg.metadata or {},
                                )
                            )
                    except asyncio.CancelledError:
                        outcome = "cancelled"
                        logger.info("Task cancelled for session {}", session_key)
                        raise
                    except Exception:
                        outcome = "error"
                        logger.exception("Error processing message for session {}", session_key)
                        # Carry msg.metadata (including reply_group_id) so the
                        # client can group the error frame with the in-flight reply.
                        err_meta = dict(msg.metadata or {})
                        await self.bus.publish_outbound(
                            OutboundMessage(
                                channel=msg.channel,
                                chat_id=msg.chat_id,
                                content="Sorry, I encountered an error.",
                                metadata=err_meta,
                            )
                        )
                    finally:
                        elapsed_ms = (time.perf_counter() - t0) * 1000
                        logger.info(
                            "agent_turn_done outcome={} elapsed_ms={:.1f}",
                            outcome,
                            elapsed_ms,
                        )
                        if turn_lifecycle:
                            await self._publish_session_turn_lifecycle(msg, phase="end")
        finally:
            # Drain any messages still in the pending queue and re-publish
            # them to the bus so they are processed as fresh inbound messages
            # rather than silently lost.
            queue = self._pending_queues.pop(session_key, None)
            if queue is not None:
                leftover = 0
                while True:
                    try:
                        item = queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                    await self.bus.publish_inbound(item)
                    leftover += 1
                if leftover:
                    logger.info(
                        "Re-published {} leftover message(s) to bus for session {}",
                        leftover,
                        session_key,
                    )

    async def close_mcp(self) -> None:
        """Drain pending background archives, then close MCP connections."""
        if self._background_tasks:
            await asyncio.gather(*self._background_tasks, return_exceptions=True)
            self._background_tasks.clear()
        for name, stack in self._mcp_stacks.items():
            try:
                await stack.aclose()
            except (RuntimeError, BaseExceptionGroup):
                logger.debug("MCP server '{}' cleanup error (can be ignored)", name)
        self._mcp_stacks.clear()

    def _schedule_background(self, coro) -> None:
        """Schedule a coroutine as a tracked background task (drained on shutdown)."""
        task = asyncio.create_task(coro)
        self._background_tasks.append(task)
        task.add_done_callback(self._background_tasks.remove)

    def stop(self) -> None:
        """Stop the agent loop."""
        self._running = False
        logger.info("Agent loop stopping")

    @staticmethod
    def _resolve_reply_group_id(msg: InboundMessage) -> str:
        """Resolve (or create) ``reply_group_id`` for *msg* metadata in-place.

        ``_dispatch`` already injects the id; direct callers (``process_direct``
        / system turns) reach this codepath without going through dispatch, so
        we mint a UUID on demand and persist it back into the metadata so all
        downstream publishers carry the same value.
        """
        meta = dict(msg.metadata or {})
        existing = meta.get("reply_group_id")
        if isinstance(existing, str) and existing.strip():
            return existing
        new_id = str(uuid.uuid4())
        meta["reply_group_id"] = new_id
        # ``InboundMessage`` is a dataclass so mutating metadata in place is
        # acceptable; callers may also dataclasses.replace to refresh.
        try:
            msg.metadata.clear()
            msg.metadata.update(meta)
        except Exception:
            # Best-effort: if metadata is immutable, the caller is expected to
            # propagate ``new_id`` explicitly via ``_run_agent_loop``.
            pass
        return new_id

    async def _process_message(
        self,
        msg: InboundMessage,
        session_key: str | None = None,
        on_progress: Callable[[str], Awaitable[None]] | None = None,
        on_stream: Callable[[str], Awaitable[None]] | None = None,
        on_stream_end: Callable[..., Awaitable[None]] | None = None,
        pending_queue: asyncio.Queue | None = None,
    ) -> OutboundMessage | None:
        """Process a single inbound message and return the response."""
        self._maybe_refresh_gateway_identity()
        reply_group_id = self._resolve_reply_group_id(msg)
        # System messages: parse origin from chat_id ("channel:chat_id")
        if msg.channel == "system":
            channel, chat_id = (
                msg.chat_id.split(":", 1) if ":" in msg.chat_id else ("cli", msg.chat_id)
            )
            logger.info("Processing system message from {}", msg.sender_id)
            key = f"{channel}:{chat_id}"
            session = self.sessions.get_or_create(key)
            if self._restore_runtime_checkpoint(session):
                self.sessions.save(session)
            if self._restore_pending_user_turn(session):
                self.sessions.save(session)

            session, pending = self.auto_compact.prepare_session(session, key)

            await self.consolidator.maybe_consolidate_by_tokens(
                session,
                session_summary=pending,
            )
            # Persist subagent follow-ups into durable history BEFORE prompt
            # assembly. ContextBuilder merges adjacent same-role messages for
            # provider compatibility, which previously caused the follow-up to
            # disappear from session.messages while still being visible to the
            # LLM via the merged prompt. See _persist_subagent_followup.
            is_subagent = msg.sender_id == "subagent"
            if is_subagent and self._persist_subagent_followup(session, msg):
                self.sessions.save(session)
            self._pending_cron_capture = (dict(msg.metadata or {}), key)
            self._set_tool_context(channel, chat_id, msg.metadata.get("message_id"))
            _hcap = self.max_history_messages if self.max_history_messages > 0 else 0
            history = session.get_history(max_messages=_hcap)
            current_role = "assistant" if is_subagent else "user"

            # Subagent content is already in `history` above; passing it again
            # as current_message would double-project it into the prompt.
            messages = self.context.build_messages(
                history=history,
                current_message="" if is_subagent else msg.content,
                channel=channel,
                chat_id=chat_id,
                session_summary=pending,
                current_role=current_role,
            )
            self._snapshot_turn_context(
                session.key,
                messages,
                channel=channel,
                chat_id=chat_id,
                source="system_turn",
            )
            final_content, _, all_msgs, stop_reason, _ = await self._run_agent_loop(
                messages,
                session=session,
                channel=channel,
                chat_id=chat_id,
                message_id=msg.metadata.get("message_id"),
                pending_queue=pending_queue,
                reply_group_id=reply_group_id,
            )
            self._save_turn(
                session, all_msgs, 1 + len(history), reply_group_id=reply_group_id
            )
            self._clear_runtime_checkpoint(session)
            self.sessions.save(session)
            self._schedule_background(self.consolidator.maybe_consolidate_by_tokens(session))
            turn_reasoning = self._collect_turn_reasoning_from_new_messages(
                all_msgs[len(messages) :]
            )
            meta_sys: dict[str, Any] = {}
            if turn_reasoning and self._should_attach_reasoning_to_outbound():
                meta_sys["reasoning_content"] = turn_reasoning
            # Carry the turn UUID to the final outbound so any channel that
            # listens to the system turn (e.g. WS reasoning frame) can group
            # this reply with the rest of the live stream.
            if reply_group_id:
                meta_sys["reply_group_id"] = reply_group_id
            sys_options = (
                ask_user_options_from_messages(all_msgs) if stop_reason == "ask_user" else []
            )
            sys_content, sys_buttons = ask_user_outbound(
                final_content or "Background task completed.",
                sys_options,
                channel,
            )
            return OutboundMessage(
                channel=channel,
                chat_id=chat_id,
                content=sys_content,
                metadata=meta_sys,
                buttons=sys_buttons,
            )

        # Extract document text from media at the processing boundary so all
        # channels benefit without format-specific logic in ContextBuilder.
        if msg.media:
            new_content, image_only = extract_documents(msg.content, msg.media)
            msg = dataclasses.replace(msg, content=new_content, media=image_only)

        preview = msg.content[:80] + "..." if len(msg.content) > 80 else msg.content
        logger.info("Processing message from {}:{}: {}", msg.channel, msg.sender_id, preview)

        key = session_key or msg.session_key
        session = self.sessions.get_or_create(key)
        if self._restore_runtime_checkpoint(session):
            self.sessions.save(session)
        if self._restore_pending_user_turn(session):
            self.sessions.save(session)

        session, pending = self.auto_compact.prepare_session(session, key)

        # Slash commands
        raw = msg.content.strip()
        ctx = CommandContext(msg=msg, session=session, key=key, raw=raw, loop=self)
        if result := await self.commands.dispatch(ctx):
            return result

        await self.consolidator.maybe_consolidate_by_tokens(
            session,
            session_summary=pending,
        )

        self._pending_cron_capture = (dict(msg.metadata or {}), key)
        self._set_tool_context(msg.channel, msg.chat_id, msg.metadata.get("message_id"))
        if message_tool := self.tools.get("message"):
            if isinstance(message_tool, MessageTool):
                message_tool.start_turn()

        history_full = session.get_history(max_messages=0)
        pending_ask_id = pending_ask_user_id(history_full)
        _hcap = self.max_history_messages if self.max_history_messages > 0 else 0
        history = history_full if pending_ask_id else session.get_history(max_messages=_hcap)

        # If the previous turn ended on an ``ask_user`` interrupt, treat
        # this inbound message as the user's answer and feed it back as
        # the missing tool result rather than starting a fresh user turn.
        if pending_ask_id:
            initial_messages = ask_user_tool_result_messages(
                self.context.build_system_prompt(channel=msg.channel),
                history_full,
                pending_ask_id,
                msg.content,
            )
        else:
            initial_messages = self.context.build_messages(
                history=history,
                current_message=msg.content,
                session_summary=pending,
                media=msg.media if msg.media else None,
                channel=msg.channel,
                chat_id=msg.chat_id,
            )
        self._snapshot_turn_context(
            session.key,
            initial_messages,
            channel=msg.channel,
            chat_id=msg.chat_id,
            source="agent_turn",
        )

        async def _publish(**meta: Any) -> None:
            content = meta.pop("content", "")
            await self.bus.publish_outbound(
                _reply_to(msg, content, extra_metadata=meta)
            )

        async def _on_retry_wait(content: str) -> None:
            await self.bus.publish_outbound(
                _reply_to(msg, content, extra_metadata={"_retry_wait": True})
            )

        # Persist the triggering user message immediately, before running the
        # agent loop. If the process is killed mid-turn (OOM, SIGKILL, self-
        # restart, etc.), the existing runtime_checkpoint preserves the
        # in-flight assistant/tool state but NOT the user message itself, so
        # the user's prompt is silently lost on recovery. Saving it up front
        # makes recovery possible from the session log alone.
        user_persisted_early = False
        # When resolving a pending ask_user, the inbound text is the
        # tool answer — recording it as a user turn would corrupt the
        # session into ``user → user → tool`` and make the LLM see the
        # answer twice (once as user, once as tool result).
        if (
            not pending_ask_id
            and isinstance(msg.content, str)
            and msg.content.strip()
        ):
            session.add_message("user", msg.content, reply_group_id=reply_group_id)
            self._mark_pending_user_turn(session)
            _tr = getattr(self, "_session_transcript", None)
            if _tr and _tr.enabled:
                _tr.append_session_message_snapshot(session.key, session.messages[-1])
            self.sessions.save(session)
            user_persisted_early = True

        async def _bus_progress(
            content: str,
            *,
            tool_hint: bool = False,
            tool_events: list[dict[str, Any]] | None = None,
        ) -> None:
            extra: dict[str, Any] = {"content": content, "_progress": True, "_tool_hint": tool_hint}
            if tool_events:
                extra["_tool_events"] = tool_events
            await _publish(**extra)

        async def _bus_tool_event(
            *,
            tool_calls: list[dict[str, Any]] | None = None,
            tool_results: list[dict[str, Any]] | None = None,
        ) -> None:
            extra: dict[str, Any] = {"_tool_event": True}
            if tool_calls is not None:
                extra["tool_calls"] = tool_calls
            if tool_results is not None:
                extra["tool_results"] = tool_results
            await _publish(**extra)

        final_content, _, all_msgs, stop_reason, had_injections = await self._run_agent_loop(
            initial_messages,
            on_progress=on_progress or _bus_progress,
            on_stream=on_stream,
            on_stream_end=on_stream_end,
            on_retry_wait=_on_retry_wait,
            on_tool_event=_bus_tool_event,
            session=session,
            channel=msg.channel,
            chat_id=msg.chat_id,
            message_id=msg.metadata.get("message_id"),
            pending_queue=pending_queue,
            reply_group_id=reply_group_id,
        )

        if final_content is None or not final_content.strip():
            final_content = EMPTY_FINAL_RESPONSE_MESSAGE

        # Skip the already-persisted user message when saving the turn
        save_skip = 1 + len(history) + (1 if user_persisted_early else 0)
        self._save_turn(
            session, all_msgs, save_skip, reply_group_id=reply_group_id
        )
        self._clear_pending_user_turn(session)
        self._clear_runtime_checkpoint(session)
        self.sessions.save(session)
        self._schedule_background(self.consolidator.maybe_consolidate_by_tokens(session))

        # When follow-up messages were injected mid-turn, a later natural
        # language reply may address those follow-ups and should not be
        # suppressed just because MessageTool was used earlier in the turn.
        # However, if the turn falls back to the empty-final-response
        # placeholder, suppress it when the real user-visible output already
        # came from MessageTool.
        if (mt := self.tools.get("message")) and isinstance(mt, MessageTool) and mt._sent_in_turn:
            if not had_injections or stop_reason == "empty_final_response":
                return None

        preview = final_content[:120] + "..." if len(final_content) > 120 else final_content
        tid = get_trace_id()
        if tid:
            logger.info(
                "Response to {}:{} (trace_id={}): {}", msg.channel, msg.sender_id, tid, preview
            )
        else:
            logger.info("Response to {}:{}: {}", msg.channel, msg.sender_id, preview)

        meta = dict(msg.metadata or {})
        # When the turn paused on ask_user, render the question and any
        # provided options as either native buttons (Telegram) or a
        # numbered list spliced into the body.
        outbound_buttons: list[list[str]] = []
        if stop_reason == "ask_user":
            final_content, outbound_buttons = ask_user_outbound(
                final_content,
                ask_user_options_from_messages(all_msgs),
                msg.channel,
            )
        if on_stream is not None and stop_reason not in {"ask_user", "error"}:
            meta["_streamed"] = True
        turn_reasoning = self._collect_turn_reasoning_from_new_messages(
            all_msgs[len(initial_messages) :]
        )
        if turn_reasoning and self._should_attach_reasoning_to_outbound():
            meta["reasoning_content"] = turn_reasoning
        return OutboundMessage(
            channel=msg.channel,
            chat_id=msg.chat_id,
            content=final_content,
            metadata=meta,
            buttons=outbound_buttons,
        )

    def _should_attach_reasoning_to_outbound(self) -> bool:
        """Whether to attach reasoning_content when channels.send_reasoning_content is true."""
        ch = self.channels_config
        if ch is not None and not getattr(ch, "send_reasoning_content", True):
            return False
        return True

    @staticmethod
    def _collect_turn_reasoning_from_new_messages(
        new_messages: list[dict[str, Any]],
    ) -> str | None:
        """Join non-empty assistant reasoning_content from messages appended this turn."""
        parts: list[str] = []
        for m in new_messages:
            if m.get("role") != "assistant":
                continue
            rc = m.get("reasoning_content")
            if isinstance(rc, str) and rc.strip():
                parts.append(rc.strip())
        if not parts:
            return None
        return "\n\n".join(parts)

    def _sanitize_persisted_blocks(
        self,
        content: list[dict[str, Any]],
        *,
        should_truncate_text: bool = False,
        drop_runtime: bool = False,
    ) -> list[dict[str, Any]]:
        """Strip volatile multimodal payloads before writing session history."""
        filtered: list[dict[str, Any]] = []
        for block in content:
            if not isinstance(block, dict):
                filtered.append(block)
                continue

            if (
                drop_runtime
                and block.get("type") == "text"
                and isinstance(block.get("text"), str)
                and block["text"].startswith(ContextBuilder._RUNTIME_CONTEXT_TAG)
            ):
                continue

            if block.get("type") == "image_url" and block.get("image_url", {}).get(
                "url", ""
            ).startswith("data:image/"):
                path = (block.get("_meta") or {}).get("path", "")
                filtered.append({"type": "text", "text": image_placeholder_text(path)})
                continue

            if block.get("type") == "text" and isinstance(block.get("text"), str):
                text = block["text"]
                if should_truncate_text and len(text) > self.max_tool_result_chars:
                    text = truncate_text_fn(text, self.max_tool_result_chars)
                filtered.append({**block, "text": text})
                continue

            filtered.append(block)

        return filtered

    def _save_turn(
        self,
        session: Session,
        messages: list[dict],
        skip: int,
        *,
        reply_group_id: str | None = None,
    ) -> None:
        """Save new-turn messages into session, truncating large tool results.

        Stamps ``reply_group_id`` onto every assistant / tool / user line that
        does not already carry one before it lands in ``session.messages`` or
        the transcript JSONL.  This is the safety net for messages that did
        not flow through ``_LoopHook`` (final assistant after iteration ended,
        runner-injected tool error placeholders, system / process_direct
        turns, etc.) so the UI can group every line into the correct reply.
        """
        for m in messages[skip:]:
            if reply_group_id and isinstance(m, dict) and not m.get("reply_group_id"):
                m["reply_group_id"] = reply_group_id
            entry = dict(m)
            # Capture the pre-truncation snapshot for the transcript: session.messages
            # gets truncated to bound prompt size, but transcript honours
            # ``include_full_tool_results`` independently.
            transcript_entry = dict(entry)
            entry.pop("_transcript_written", None)
            role, content = entry.get("role"), entry.get("content")
            if role == "assistant" and not content and not entry.get("tool_calls"):
                continue  # skip empty assistant messages — they poison session context
            if role == "tool":
                if isinstance(content, str) and len(content) > self.max_tool_result_chars:
                    entry["content"] = truncate_text_fn(content, self.max_tool_result_chars)
                elif isinstance(content, list):
                    filtered = self._sanitize_persisted_blocks(content, should_truncate_text=True)
                    if not filtered:
                        continue
                    entry["content"] = filtered
            elif role == "user":
                uc = entry.get("content")
                if isinstance(uc, str) and uc.startswith(ContextBuilder._RUNTIME_CONTEXT_TAG):
                    end_marker = ContextBuilder._RUNTIME_CONTEXT_END
                    end_pos = uc.find(end_marker)
                    if end_pos >= 0:
                        after = uc[end_pos + len(end_marker) :].lstrip("\n")
                        if after:
                            entry["content"] = after
                        else:
                            continue
                    else:
                        after_tag = uc[len(ContextBuilder._RUNTIME_CONTEXT_TAG) :].lstrip("\n")
                        if after_tag.strip():
                            entry["content"] = after_tag
                        else:
                            continue
                if isinstance(entry.get("content"), str):
                    peer = peer_user_visible_from_llm_event_block(entry["content"])
                    if peer is not None:
                        entry["content"] = peer["content"]
                        entry["injected_event"] = "agent_direct"
                        sid = peer.get("sender_agent_id")
                        if sid:
                            entry["sender_agent_id"] = sid
                uc = entry.get("content")
                if isinstance(uc, list):
                    filtered = self._sanitize_persisted_blocks(uc, drop_runtime=True)
                    if not filtered:
                        continue
                    entry["content"] = filtered
                elif isinstance(uc, str) and not uc.strip():
                    continue
            entry.setdefault("timestamp", timestamp(self.timezone))
            _tr = getattr(self, "_session_transcript", None)
            if _tr and _tr.enabled and not m.get("_transcript_written"):
                # Carry over any reply_group_id / sender_agent_id added during processing
                # so the transcript record stays consistent with the session entry.
                for k in ("reply_group_id", "sender_agent_id", "injected_event", "timestamp"):
                    if k in entry and k not in transcript_entry:
                        transcript_entry[k] = entry[k]
                transcript_entry.pop("_transcript_written", None)
                _tr.append_raw_turn_message(session.key, transcript_entry)
            session.messages.append(entry)
            session.updated_at = local_now(self.timezone)

    def _persist_subagent_followup(self, session: Session, msg: InboundMessage) -> bool:
        """Persist subagent follow-ups before prompt assembly so history stays durable.

        Returns True if a new entry was appended; False if the follow-up was
        deduped (same ``subagent_task_id`` already in session) or carries no
        content worth persisting.
        """
        if not msg.content:
            return False
        meta = msg.metadata if isinstance(msg.metadata, dict) else {}
        task_id = meta.get("subagent_task_id")
        if task_id and any(
            m.get("injected_event") == "subagent_result" and m.get("subagent_task_id") == task_id
            for m in session.messages
        ):
            return False
        # Stamp the parent turn's reply_group_id so the subagent answer is
        # grouped with the rest of the assistant reply in transcript replay.
        rg = meta.get("reply_group_id") if isinstance(meta, dict) else None
        extra: dict[str, Any] = {
            "sender_id": msg.sender_id,
            "injected_event": "subagent_result",
            "subagent_task_id": task_id,
        }
        if isinstance(rg, str) and rg:
            extra["reply_group_id"] = rg
        session.add_message("assistant", msg.content, **extra)
        return True

    def _set_runtime_checkpoint(self, session: Session, payload: dict[str, Any]) -> None:
        """Persist the latest in-flight turn state into session metadata."""
        session.metadata[self._RUNTIME_CHECKPOINT_KEY] = payload
        self.sessions.save(session)

    def _mark_pending_user_turn(self, session: Session) -> None:
        session.metadata[self._PENDING_USER_TURN_KEY] = True

    def _clear_pending_user_turn(self, session: Session) -> None:
        session.metadata.pop(self._PENDING_USER_TURN_KEY, None)

    def _clear_runtime_checkpoint(self, session: Session) -> None:
        if self._RUNTIME_CHECKPOINT_KEY in session.metadata:
            session.metadata.pop(self._RUNTIME_CHECKPOINT_KEY, None)

    @staticmethod
    def _checkpoint_message_key(message: dict[str, Any]) -> tuple[Any, ...]:
        return (
            message.get("role"),
            message.get("content"),
            message.get("tool_call_id"),
            message.get("name"),
            message.get("tool_calls"),
            message.get("reasoning_content"),
            message.get("thinking_blocks"),
        )

    def _restore_runtime_checkpoint(self, session: Session) -> bool:
        """Materialize an unfinished turn into session history before a new request."""
        checkpoint = session.metadata.get(self._RUNTIME_CHECKPOINT_KEY)
        if not isinstance(checkpoint, dict):
            return False

        assistant_message = checkpoint.get("assistant_message")
        completed_tool_results = checkpoint.get("completed_tool_results") or []
        pending_tool_calls = checkpoint.get("pending_tool_calls") or []

        restored_messages: list[dict[str, Any]] = []
        if isinstance(assistant_message, dict):
            restored = dict(assistant_message)
            # Drop in-memory inflight marker before rehydrating into session.
            restored.pop("_transcript_written", None)
            restored.setdefault("timestamp", timestamp(self.timezone))
            restored_messages.append(restored)
        for message in completed_tool_results:
            if isinstance(message, dict):
                restored = dict(message)
                restored.pop("_transcript_written", None)
                restored.setdefault("timestamp", timestamp(self.timezone))
                restored_messages.append(restored)
        for tool_call in pending_tool_calls:
            if not isinstance(tool_call, dict):
                continue
            tool_id = tool_call.get("id")
            name = ((tool_call.get("function") or {}).get("name")) or "tool"
            restored_messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tool_id,
                    "name": name,
                    "content": "Error: Task interrupted before this tool finished.",
                    "timestamp": timestamp(self.timezone),
                }
            )

        overlap = 0
        max_overlap = min(len(session.messages), len(restored_messages))
        for size in range(max_overlap, 0, -1):
            existing = session.messages[-size:]
            restored = restored_messages[:size]
            if all(
                self._checkpoint_message_key(left) == self._checkpoint_message_key(right)
                for left, right in zip(existing, restored)
            ):
                overlap = size
                break
        session.messages.extend(restored_messages[overlap:])

        self._clear_pending_user_turn(session)
        self._clear_runtime_checkpoint(session)
        return True

    def _restore_pending_user_turn(self, session: Session) -> bool:
        """Close a turn that only persisted the user message before crashing."""
        if not session.metadata.get(self._PENDING_USER_TURN_KEY):
            return False

        if session.messages and session.messages[-1].get("role") == "user":
            session.messages.append(
                {
                    "role": "assistant",
                    "content": "Error: Task interrupted before a response was generated.",
                    "timestamp": timestamp(self.timezone),
                }
            )
            session.updated_at = local_now(self.timezone)

        self._clear_pending_user_turn(session)
        return True

    async def process_direct(
        self,
        content: str,
        session_key: str = "cli:direct",
        channel: str = "cli",
        chat_id: str = "direct",
        media: list[str] | None = None,
        on_progress: Callable[[str], Awaitable[None]] | None = None,
        on_stream: Callable[[str], Awaitable[None]] | None = None,
        on_stream_end: Callable[..., Awaitable[None]] | None = None,
    ) -> OutboundMessage | None:
        """Process a message directly and return the outbound payload."""
        await self._connect_mcp()
        msg = InboundMessage(
            channel=channel,
            sender_id="user",
            chat_id=chat_id,
            content=content,
            media=media or [],
        )
        turn_id = str(uuid.uuid4())
        t0 = time.perf_counter()
        outcome = "ok"
        with logger.contextualize(
            turn_id=turn_id,
            session_key=session_key,
            channel=channel,
            chat_id=chat_id,
            sender=msg.sender_id,
        ):
            try:
                return await self._process_message(
                    msg,
                    session_key=session_key,
                    on_progress=on_progress,
                    on_stream=on_stream,
                    on_stream_end=on_stream_end,
                )
            except asyncio.CancelledError:
                outcome = "cancelled"
                raise
            except Exception:
                outcome = "error"
                raise
            finally:
                elapsed_ms = (time.perf_counter() - t0) * 1000
                logger.info(
                    "agent_turn_done outcome={} elapsed_ms={:.1f}",
                    outcome,
                    elapsed_ms,
                )
