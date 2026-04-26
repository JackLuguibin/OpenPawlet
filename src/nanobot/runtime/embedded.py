"""Embedded nanobot runtime.

Encapsulates everything that the legacy ``nanobot gateway`` CLI used to
spin up (agent loop, channels, cron, heartbeat, team runtime, dream job,
etc.) so that the OpenPawlet console FastAPI process can host it
in-process via its ``lifespan`` instead of spawning a separate gateway
subprocess.

Typical usage from a FastAPI lifespan::

    embedded = EmbeddedNanobot.from_environment()
    await embedded.start()
    try:
        yield
    finally:
        await embedded.stop()

The runtime intentionally exposes a small surface (``agent`` /
``message_bus`` / ``channels`` / ``session_manager`` properties) so the
Console can wire HTTP and WebSocket routes directly to the live objects.
"""

from __future__ import annotations

import asyncio
import os
import time
from collections import defaultdict
from collections.abc import Callable
from typing import Any

from loguru import logger

from nanobot import __logo__, __version__
from nanobot.config.paths import is_default_workspace
from nanobot.config.schema import Config


class EmbeddedNanobot:
    """In-process nanobot gateway runtime.

    The class deliberately performs all heavy construction in
    :meth:`__init__` so that callers can reason about failures before any
    background tasks are spawned.  ``start`` then launches the agent
    loop, cron, heartbeat, channels and team workers as long-lived
    asyncio tasks and ``stop`` reverses the order with best-effort
    cleanup.
    """

    def __init__(
        self,
        *,
        config: Config,
        verbose: bool = False,
        provider_factory: Callable[[Config], Any] | None = None,
    ) -> None:
        from nanobot.agent.loop import AgentLoop
        from nanobot.bus.factory import build_message_bus
        from nanobot.channels.manager import ChannelManager
        from nanobot.channels.websocket import WebSocketChannel
        from nanobot.cron.service import CronService
        from nanobot.cron.types import CronJob, CronPayload
        from nanobot.heartbeat.service import HeartbeatService
        from nanobot.session.manager import SessionManager
        from nanobot.utils.console_agents import (
            console_agent_display_name,
            resolve_gateway_identity_overrides,
        )
        from nanobot.utils.helpers import sync_workspace_templates
        from nanobot.utils.team_gateway_runtime import (
            load_all_team_member_bindings,
            resolve_effective_gateway_agent_id,
            resolve_gateway_team_context,
        )

        if provider_factory is None:
            from nanobot.cli.commands import (
                _make_provider as provider_factory,  # type: ignore[no-redef]
            )

        if verbose:
            import logging

            logging.basicConfig(level=logging.DEBUG)

        self._config = config
        self._verbose = verbose
        self._provider_factory = provider_factory

        sync_workspace_templates(config.workspace_path)

        # Infer agent identity for bus + console display.
        if not os.environ.get("NANOBOT_AGENT_ID", "").strip():
            inferred_aid = resolve_effective_gateway_agent_id(config.workspace_path)
            if inferred_aid:
                os.environ["NANOBOT_AGENT_ID"] = inferred_aid
                logger.info(
                    "Inferred NANOBOT_AGENT_ID from workspace: {} "
                    "(needed for team agent.direct routing)",
                    inferred_aid,
                )
        bus_aid = os.environ.get("NANOBOT_AGENT_ID", "").strip()
        bus_an = os.environ.get("NANOBOT_AGENT_NAME", "").strip()
        if bus_aid and not bus_an:
            bus_an = console_agent_display_name(config.workspace_path, bus_aid)

        self._primary_aid = bus_aid

        # Build core collaborators.
        self.message_bus = build_message_bus(role="full", agent_id=bus_aid, agent_name=bus_an)
        self.provider = provider_factory(config)
        self.session_manager = SessionManager(
            config.workspace_path,
            timezone=config.agents.defaults.timezone,
        )

        if is_default_workspace(config.workspace_path):
            self._migrate_cron_store(config)

        cron_store_path = config.workspace_path / "cron" / "jobs.json"
        self.cron = CronService(cron_store_path)

        env_team_id, env_room_id, all_team_member_ids = resolve_gateway_team_context(
            config.workspace_path
        )
        self._env_team_id = env_team_id
        self._env_room_id = env_room_id
        team_member_ids = all_team_member_ids
        if bus_aid:
            team_member_ids = [m for m in all_team_member_ids if m != bus_aid]
        self._team_member_ids = team_member_ids
        if env_team_id and env_room_id and team_member_ids:
            os.environ["NANOBOT_TEAM_IN_PROCESS"] = "1"
            logger.info(
                "In-process team: {} member loop(s) (team={} room={})",
                len(team_member_ids),
                env_team_id,
                env_room_id,
            )
        elif env_team_id and env_room_id and not team_member_ids:
            logger.warning("team/room resolved but no member_agent_ids; skipping member loops")

        sub_ev = getattr(self.message_bus, "subscribe_events", None)
        if load_all_team_member_bindings(config.workspace_path) and sub_ev is None:
            raise RuntimeError(
                "team runtime requires a message bus with subscribe_events "
                "(enable queue manager / ZMQ events path)"
            )

        gw_aid = bus_aid or None
        gw_model, gw_disabled, gw_console_prompt = resolve_gateway_identity_overrides(
            config,
            config.workspace_path,
            logical_agent_id=gw_aid,
            team_id=env_team_id or None,
        )

        self.agent = AgentLoop(
            bus=self.message_bus,
            provider=self.provider,
            workspace=config.workspace_path,
            model=gw_model,
            max_iterations=config.agents.defaults.max_tool_iterations,
            context_window_tokens=config.agents.defaults.context_window_tokens,
            web_config=config.tools.web,
            context_block_limit=config.agents.defaults.context_block_limit,
            max_tool_result_chars=config.agents.defaults.max_tool_result_chars,
            provider_retry_mode=config.agents.defaults.provider_retry_mode,
            exec_config=config.tools.exec,
            cron_service=self.cron,
            restrict_to_workspace=config.tools.restrict_to_workspace,
            session_manager=self.session_manager,
            mcp_servers=config.tools.mcp_servers,
            channels_config=config.channels,
            timezone=config.agents.defaults.timezone,
            unified_session=config.agents.defaults.unified_session,
            disabled_skills=gw_disabled,
            console_system_prompt=gw_console_prompt,
            session_ttl_minutes=config.agents.defaults.session_ttl_minutes,
            tools_config=config.tools,
            persist_session_transcript=config.agents.defaults.persist_session_transcript,
            transcript_include_full_tool_results=(
                config.agents.defaults.transcript_include_full_tool_results
            ),
            runtime_config=config,
        )

        self._team_loops_by_agent: dict[str, AgentLoop] = {}
        self._team_tasks_by_agent: dict[str, asyncio.Task[None]] = {}
        self._team_bindings_by_session: dict[str, tuple[str, str, str, str]] = {}
        self._team_primary_session_by_agent: dict[str, str] = {}
        self._primary_team_event_task: asyncio.Task[None] | None = None

        self._sync_bindings_from_workspace()
        for aid, first_sk in self._team_primary_session_by_agent.items():
            binding = self._team_bindings_by_session.get(first_sk)
            team_id_hint = binding[0] if binding else None
            self._team_loops_by_agent[aid] = self._build_member_loop(aid, team_id_hint)

        # Wire cron callback (depends on agent + bus + provider).
        self.cron.on_job = self._on_cron_job

        # Channels (need a fully built agent so they can resolve busy state).
        self.channels = ChannelManager(
            config, self.message_bus, session_manager=self.session_manager
        )
        ws_ch = self.channels.channels.get("websocket")
        if isinstance(ws_ch, WebSocketChannel):
            ws_ch.set_session_busy_resolver(self.agent.is_session_busy)

        # Heartbeat depends on a target picker that uses channels + sessions.
        hb_cfg = config.gateway.heartbeat
        self._hb_cfg = hb_cfg
        self.heartbeat = HeartbeatService(
            workspace=config.workspace_path,
            provider=self.provider,
            model=self.agent.model,
            on_execute=self._on_heartbeat_execute,
            on_notify=self._on_heartbeat_notify,
            interval_s=hb_cfg.interval_s,
            enabled=hb_cfg.enabled,
            timezone=config.agents.defaults.timezone,
        )

        # Register Dream system job (always-on, idempotent on restart).
        dream_cfg = config.agents.defaults.dream
        if dream_cfg.model_override:
            self.agent.dream.model = dream_cfg.model_override
        self.agent.dream.max_batch_size = dream_cfg.max_batch_size
        self.agent.dream.max_iterations = dream_cfg.max_iterations
        self.agent.dream.annotate_line_ages = dream_cfg.annotate_line_ages
        self.cron.register_system_job(
            CronJob(
                id="dream",
                name="dream",
                schedule=dream_cfg.build_schedule(config.agents.defaults.timezone),
                payload=CronPayload(kind="system_event"),
            )
        )

        self._tasks: list[asyncio.Task[None]] = []
        self._reconciler_task: asyncio.Task[None] | None = None
        self._started = False
        # Set when ``stop()`` has begun so control-plane callers (e.g. the
        # console UnifiedAgentManager) can refuse to spawn new agent tasks
        # against a runtime mid-shutdown.
        self._stopping = False
        self._start_perf = 0.0

    # ---- public lifecycle ------------------------------------------------
    @classmethod
    def from_environment(
        cls,
        *,
        config_path: str | None = None,
        workspace: str | None = None,
        verbose: bool = False,
        websocket_host: str | None = None,
        websocket_port: int | None = None,
        websocket_path: str = "/",
        websocket_requires_token: bool = False,
    ) -> EmbeddedNanobot:
        """Build an instance from on-disk config (matches legacy ``nanobot gateway``)."""
        from nanobot.cli.commands import _load_runtime_config

        cfg = _load_runtime_config(config_path, workspace)
        # Unified console mode always relies on the in-process websocket channel.
        # Ensure it is enabled and aligned with the reverse-proxy target.
        ws_cfg_raw = getattr(cfg.channels, "websocket", None)
        ws_cfg: dict[str, Any] = dict(ws_cfg_raw) if isinstance(ws_cfg_raw, dict) else {}
        ws_cfg["enabled"] = True
        if websocket_host is not None:
            ws_cfg["host"] = websocket_host
        if websocket_port is not None:
            ws_cfg["port"] = websocket_port
        ws_cfg["path"] = websocket_path
        ws_cfg["websocket_requires_token"] = websocket_requires_token
        setattr(cfg.channels, "websocket", ws_cfg)
        return cls(config=cfg, verbose=verbose)

    async def start(self) -> None:
        """Start agent loop, cron, heartbeat, channels and team workers."""
        if self._started:
            return
        self._started = True
        self._start_perf = time.perf_counter()
        logger.info("{} Starting embedded nanobot runtime version {}", __logo__, __version__)

        await self._ensure_team_runtime()
        self._reconciler_task = asyncio.create_task(
            self._team_runtime_reconciler(), name="team-runtime-reconciler"
        )

        await self.cron.start()
        await self.heartbeat.start()

        agent_task = asyncio.create_task(self.agent.run(), name="nanobot-agent-run")
        channels_task = asyncio.create_task(self.channels.start_all(), name="nanobot-channels")
        self._tasks.extend([agent_task, channels_task, self._reconciler_task])

    async def stop(self) -> None:
        """Reverse of :meth:`start` - cancel and drain everything."""
        if not self._started:
            return
        self._started = False
        self._stopping = True

        if self._reconciler_task is not None:
            self._reconciler_task.cancel()
            await asyncio.gather(self._reconciler_task, return_exceptions=True)
            self._reconciler_task = None

        for task in list(self._team_tasks_by_agent.values()):
            task.cancel()
        if self._team_tasks_by_agent:
            await asyncio.gather(*self._team_tasks_by_agent.values(), return_exceptions=True)
        self._team_tasks_by_agent.clear()

        if self._primary_team_event_task is not None and not self._primary_team_event_task.done():
            self._primary_team_event_task.cancel()
            await asyncio.gather(self._primary_team_event_task, return_exceptions=True)
        self._primary_team_event_task = None

        for mloop in list(self._team_loops_by_agent.values()):
            try:
                await mloop.close_mcp()
            except Exception:  # pragma: no cover - best effort cleanup
                logger.exception("Failed to close MCP for member loop")
        self._team_loops_by_agent.clear()

        try:
            await self.agent.close_mcp()
        except Exception:  # pragma: no cover
            logger.exception("Failed to close MCP for primary loop")

        try:
            self.heartbeat.stop()
        except Exception:  # pragma: no cover
            logger.exception("Heartbeat stop failed")
        try:
            self.cron.stop()
        except Exception:  # pragma: no cover
            logger.exception("Cron stop failed")
        try:
            self.agent.stop()
        except Exception:  # pragma: no cover
            logger.exception("Agent stop failed")

        try:
            await self.channels.stop_all()
        except Exception:  # pragma: no cover
            logger.exception("Channel manager stop failed")

        for task in self._tasks:
            if not task.done():
                task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

        try:
            flushed = self.agent.sessions.flush_all()
            if flushed:
                logger.info("Shutdown: flushed {} session(s) to disk", flushed)
        except Exception:  # pragma: no cover
            logger.exception("Session flush on shutdown failed")

    async def run_forever(self) -> None:
        """Convenience helper that mirrors the legacy gateway behaviour."""
        await self.start()
        agent_task = next((t for t in self._tasks if t.get_name() == "nanobot-agent-run"), None)
        try:
            if agent_task is not None:
                await agent_task
            else:
                await asyncio.Event().wait()
        finally:
            await self.stop()

    # ---- helpers --------------------------------------------------------
    @staticmethod
    def _migrate_cron_store(config: Config) -> None:
        """One-time migration: move legacy global cron store into the workspace."""
        import shutil

        from nanobot.config.paths import get_cron_dir

        legacy_path = get_cron_dir() / "jobs.json"
        new_path = config.workspace_path / "cron" / "jobs.json"
        if legacy_path.is_file() and not new_path.exists():
            new_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(legacy_path), str(new_path))

    def _build_member_loop(self, mid: str, team_id_hint: str | None) -> Any:
        from nanobot.agent.loop import AgentLoop
        from nanobot.utils.console_agents import resolve_gateway_identity_overrides

        cfg = self._config
        m_model, m_ds, m_prompt = resolve_gateway_identity_overrides(
            cfg, cfg.workspace_path, logical_agent_id=mid, team_id=team_id_hint
        )
        mem_provider = self._provider_factory(cfg)
        return AgentLoop(
            bus=self.message_bus,
            provider=mem_provider,
            workspace=cfg.workspace_path,
            model=m_model,
            max_iterations=cfg.agents.defaults.max_tool_iterations,
            context_window_tokens=cfg.agents.defaults.context_window_tokens,
            web_config=cfg.tools.web,
            context_block_limit=cfg.agents.defaults.context_block_limit,
            max_tool_result_chars=cfg.agents.defaults.max_tool_result_chars,
            provider_retry_mode=cfg.agents.defaults.provider_retry_mode,
            exec_config=cfg.tools.exec,
            cron_service=None,
            restrict_to_workspace=cfg.tools.restrict_to_workspace,
            session_manager=self.session_manager,
            mcp_servers=cfg.tools.mcp_servers,
            channels_config=cfg.channels,
            timezone=cfg.agents.defaults.timezone,
            unified_session=False,
            disabled_skills=m_ds,
            console_system_prompt=m_prompt,
            session_ttl_minutes=cfg.agents.defaults.session_ttl_minutes,
            tools_config=cfg.tools,
            persist_session_transcript=cfg.agents.defaults.persist_session_transcript,
            transcript_include_full_tool_results=(
                cfg.agents.defaults.transcript_include_full_tool_results
            ),
            agent_id=mid,
            runtime_config=cfg,
        )

    def _rebuild_dispatch(self) -> None:
        dispatch: dict[str, Any] = {}
        for sk, (_tid, _rid, aid, _full_sk) in self._team_bindings_by_session.items():
            loop = self._team_loops_by_agent.get(aid)
            if loop is not None:
                dispatch[sk] = loop
        self.agent.team_session_dispatch = dispatch or None

    def _sync_bindings_from_workspace(self) -> None:
        from nanobot.utils.team_gateway_runtime import load_all_team_member_bindings

        all_bindings = load_all_team_member_bindings(self._config.workspace_path)
        if self._primary_aid:
            all_bindings = [b for b in all_bindings if b[2] != self._primary_aid]
        by_session = {b[3]: b for b in all_bindings}
        self._team_bindings_by_session.clear()
        self._team_bindings_by_session.update(by_session)
        grouped: dict[str, list[str]] = defaultdict(list)
        for _tid, _rid, aid, sk in all_bindings:
            grouped[aid].append(sk)
        self._team_primary_session_by_agent.clear()
        for aid, keys in grouped.items():
            self._team_primary_session_by_agent[aid] = sorted(keys)[0]
        self._rebuild_dispatch()

    async def _ensure_team_runtime(self) -> None:
        from nanobot.agent.team_serve import run_team_member_event_loop
        from nanobot.utils.team_gateway_runtime import team_member_session_key

        self._sync_bindings_from_workspace()
        desired = set(self._team_primary_session_by_agent.keys())
        existing = set(self._team_loops_by_agent.keys())

        for aid in sorted(desired - existing):
            sk = self._team_primary_session_by_agent.get(aid)
            binding = self._team_bindings_by_session.get(sk) if sk else None
            team_id_hint = binding[0] if binding else None
            self._team_loops_by_agent[aid] = self._build_member_loop(aid, team_id_hint)

        for aid in sorted(existing - desired):
            task = self._team_tasks_by_agent.pop(aid, None)
            if task is not None:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            loop = self._team_loops_by_agent.pop(aid, None)
            if loop is not None:
                await loop.close_mcp()

        for aid in sorted(desired):
            existing_task = self._team_tasks_by_agent.get(aid)
            if existing_task is not None and not existing_task.done():
                continue
            loop = self._team_loops_by_agent.get(aid)
            session_key = self._team_primary_session_by_agent.get(aid)
            if loop is None or not session_key:
                continue
            self._team_tasks_by_agent[aid] = asyncio.create_task(
                run_team_member_event_loop(self.message_bus, loop, session_key=session_key),
                name=f"team-member-{aid}",
            )
        self._rebuild_dispatch()

        sub_api = getattr(self.message_bus, "subscribe_events", None)
        want_primary_direct = (
            bool(self._primary_aid)
            and bool(self._env_team_id)
            and bool(self._env_room_id)
            and callable(sub_api)
        )
        if want_primary_direct:
            if self._primary_team_event_task is None or self._primary_team_event_task.done():
                psk = team_member_session_key(
                    self._env_team_id, self._env_room_id, self._primary_aid
                )
                self._primary_team_event_task = asyncio.create_task(
                    run_team_member_event_loop(self.message_bus, self.agent, session_key=psk),
                    name=f"team-primary-{self._primary_aid}",
                )
        else:
            if (
                self._primary_team_event_task is not None
                and not self._primary_team_event_task.done()
            ):
                self._primary_team_event_task.cancel()
                try:
                    await self._primary_team_event_task
                except asyncio.CancelledError:
                    pass
                except Exception:  # pragma: no cover
                    logger.exception("primary team direct loop cancel")
            self._primary_team_event_task = None

    def _teams_state_mtime_ns(self) -> int:
        """Return ``teams.json`` mtime in ns (0 when missing).

        Used to short-circuit the reconciler: when the file has not been
        touched since the previous tick, no member loops can have been
        added/removed and we skip the full workspace re-scan that
        :meth:`_ensure_team_runtime` would otherwise perform.
        """
        teams_path = (
            self._config.workspace_path / ".nanobot_console" / "teams.json"
        )
        try:
            return teams_path.stat().st_mtime_ns
        except FileNotFoundError:
            return 0
        except OSError:
            return -1

    async def _team_runtime_reconciler(self) -> None:
        last_mtime_ns = -2
        while True:
            try:
                current = self._teams_state_mtime_ns()
                if current != last_mtime_ns:
                    await self._ensure_team_runtime()
                    last_mtime_ns = current
            except asyncio.CancelledError:
                raise
            except Exception:  # pragma: no cover - reconciler must keep running
                logger.exception("team runtime reconcile failed")
                # Force a recompute on the next iteration so a transient
                # failure does not freeze us in stale state.
                last_mtime_ns = -2
            await asyncio.sleep(2.0)

    # ---- callbacks ------------------------------------------------------
    async def _on_cron_job(self, job: Any) -> str | None:
        """Execute a cron job through the agent (broadcast + dream + reminder)."""
        from nanobot.agent.tools.cron import CronTool
        from nanobot.agent.tools.message import MessageTool
        from nanobot.bus.envelope import TARGET_BROADCAST
        from nanobot.bus.events import AgentEvent, OutboundMessage
        from nanobot.utils.evaluator import evaluate_response

        publisher = getattr(self.message_bus, "publish_event", None)
        if publisher is not None:
            try:
                await publisher(
                    AgentEvent(
                        topic="cron.fired",
                        source_agent="system:cron",
                        target=TARGET_BROADCAST,
                        payload={
                            "job_id": job.id,
                            "name": job.name,
                            "schedule_kind": job.schedule.kind,
                            "deliver": job.payload.deliver,
                            "channel": job.payload.channel,
                            "chat_id": job.payload.to,
                            "message": job.payload.message,
                        },
                    )
                )
            except Exception as exc:  # pragma: no cover - best-effort
                logger.debug("cron.fired event publish failed: {}", exc)

        if job.name == "dream":
            try:
                await self.agent.dream.run()
                logger.info("Dream cron job completed")
            except Exception:  # pragma: no cover
                logger.exception("Dream cron job failed")
            return None

        reminder_note = (
            "[Scheduled Task] Timer finished.\n\n"
            f"Task '{job.name}' has been triggered.\n"
            f"Scheduled instruction: {job.payload.message}"
        )

        cron_tool = self.agent.tools.get("cron")
        cron_token = None
        if isinstance(cron_tool, CronTool):
            cron_token = cron_tool.set_cron_context(True)

        async def _silent(*_args: Any, **_kwargs: Any) -> None:
            return None

        try:
            resp = await self.agent.process_direct(
                reminder_note,
                session_key=f"cron:{job.id}",
                channel=job.payload.channel or "cli",
                chat_id=job.payload.to or "direct",
                on_progress=_silent,
            )
        finally:
            if isinstance(cron_tool, CronTool) and cron_token is not None:
                cron_tool.reset_cron_context(cron_token)

        response = resp.content if resp else ""

        message_tool = self.agent.tools.get("message")
        if (
            job.payload.deliver
            and isinstance(message_tool, MessageTool)
            and message_tool._sent_in_turn
        ):
            return response

        if job.payload.deliver and job.payload.to and response:
            should_notify = await evaluate_response(
                response, reminder_note, self.provider, self.agent.model
            )
            if should_notify:
                await self.message_bus.publish_outbound(
                    OutboundMessage(
                        channel=job.payload.channel or "cli",
                        chat_id=job.payload.to,
                        content=response,
                    )
                )
        return response

    def _pick_heartbeat_target(self) -> tuple[str, str]:
        """Pick a routable channel/chat target for heartbeat-triggered messages."""
        enabled = set(self.channels.enabled_channels)
        for item in self.session_manager.list_sessions():
            key = item.get("key") or ""
            if ":" not in key:
                continue
            channel, chat_id = key.split(":", 1)
            if channel in {"cli", "system"}:
                continue
            if channel in enabled and chat_id:
                return channel, chat_id
        return "cli", "direct"

    async def _on_heartbeat_execute(self, tasks: str) -> str:
        channel, chat_id = self._pick_heartbeat_target()

        async def _silent(*_args: Any, **_kwargs: Any) -> None:
            return None

        resp = await self.agent.process_direct(
            tasks,
            session_key="heartbeat",
            channel=channel,
            chat_id=chat_id,
            on_progress=_silent,
        )

        session = self.agent.sessions.get_or_create("heartbeat")
        session.retain_recent_legal_suffix(
            self._hb_cfg.keep_recent_messages,
            transcript=self.agent.session_transcript,
        )
        self.agent.sessions.save(session)

        return resp.content if resp else ""

    async def _on_heartbeat_notify(self, response: str) -> None:
        from nanobot.bus.events import OutboundMessage

        channel, chat_id = self._pick_heartbeat_target()
        if channel == "cli":
            return
        await self.message_bus.publish_outbound(
            OutboundMessage(channel=channel, chat_id=chat_id, content=response)
        )

    @property
    def uptime_s(self) -> float:
        """Return runtime uptime in seconds (0 before :meth:`start`)."""
        if not self._started:
            return 0.0
        return round(time.perf_counter() - self._start_perf, 3)


__all__ = ["EmbeddedNanobot"]
