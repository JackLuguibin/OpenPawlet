"""Unified runtime manager for main/sub agent lifecycle and status."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from nanobot.runtime.embedded import EmbeddedNanobot


@dataclass(slots=True)
class ManagedAgentStatus:
    """Normalized runtime status payload for API consumption."""

    agent_id: str
    role: str  # main | sub
    running: bool
    phase: str | None = None
    started_at: float | None = None
    uptime_seconds: float | None = None
    parent_agent_id: str | None = None
    team_id: str | None = None
    label: str | None = None
    task_description: str | None = None
    iteration: int | None = None
    stop_reason: str | None = None
    error: str | None = None
    # Sub-agent's own transcript key (``subagent:<parent>:<task_id>``) so the
    # console can fetch its dedicated transcript via /sessions/{key}/transcript.
    session_key: str | None = None
    # Original parent session key the sub-agent was spawned from.
    parent_session_key: str | None = None
    # Profile id when the sub-agent ran with an independent persona profile
    # (see :class:`nanobot.config.profile.AgentProfile`).
    profile_id: str | None = None


_STOP_TIMEOUT_S = 10.0


class UnifiedAgentManager:
    """Manage runtime lifecycle for the primary agent and subagents."""

    def __init__(self, embedded: EmbeddedNanobot) -> None:
        self._embedded = embedded
        # Serialise all start/stop control-plane operations so concurrent
        # callers cannot race two agent loops on the same bus or tear down
        # while another caller is still spawning.
        self._lifecycle_lock = asyncio.Lock()

    @property
    def main_agent_id(self) -> str:
        return str(getattr(self._embedded.agent, "agent_id", "") or "main")

    def _main_agent_task(self) -> asyncio.Task[Any] | None:
        for task in list(getattr(self._embedded, "_tasks", [])):
            if task.get_name() == "nanobot-agent-run":
                return task
        return None

    def _is_main_running(self) -> bool:
        task = self._main_agent_task()
        if task is not None and not task.done():
            return True
        return bool(getattr(self._embedded.agent, "_running", False))

    def _embedded_is_stopping(self) -> bool:
        """True when the embedded runtime has begun shutdown."""
        return bool(getattr(self._embedded, "_stopping", False))

    async def start_main(self) -> bool:
        """Start the main agent loop if it is not running.

        Refuses to start while the embedded runtime is shutting down so
        callers cannot create orphaned tasks that bypass ``embedded.stop()``
        cleanup.
        """
        async with self._lifecycle_lock:
            if self._embedded_is_stopping():
                raise RuntimeError("Embedded runtime is stopping; cannot start main agent")
            if self._is_main_running():
                return False
            task = asyncio.create_task(self._embedded.agent.run(), name="nanobot-agent-run")
            tasks = getattr(self._embedded, "_tasks", None)
            if isinstance(tasks, list):
                tasks.append(task)
            return True

    async def stop_main(self) -> bool:
        """Stop the main agent loop if it is running.

        Bounds the wait for graceful exit; if the loop ignores ``stop()``
        beyond ``_STOP_TIMEOUT_S`` we forcibly cancel and surface a warning
        so operators know something is wedged.
        """
        async with self._lifecycle_lock:
            if not self._is_main_running():
                return False
            self._embedded.agent.stop()
            task = self._main_agent_task()
            if task is None:
                return True
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=_STOP_TIMEOUT_S)
            except TimeoutError:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            except Exception:
                # ``asyncio.gather`` swallows the original exception via
                # return_exceptions=True; we mirror that here so stop_main
                # never propagates the loop's own teardown error.
                await asyncio.gather(task, return_exceptions=True)
            return True

    async def start_subagent(
        self,
        *,
        task: str,
        label: str | None = None,
        parent_agent_id: str | None = None,
        team_id: str | None = None,
        origin_channel: str = "api",
        origin_chat_id: str = "manager",
        session_key: str | None = None,
        profile_id: str | None = None,
    ) -> str:
        """Create and start a subagent task; returns subagent runtime id."""
        async with self._lifecycle_lock:
            if self._embedded_is_stopping():
                raise RuntimeError("Embedded runtime is stopping; cannot start subagent")
            tid = await self._embedded.agent.subagents.spawn_task(
                task=task,
                label=label,
                origin_channel=origin_channel,
                origin_chat_id=origin_chat_id,
                session_key=session_key,
                parent_agent_id=parent_agent_id or self.main_agent_id,
                team_id=team_id,
                profile_id=profile_id,
            )
            return f"sub:{tid}"

    async def stop_subagent(self, subagent_id: str) -> bool:
        """Stop one subagent by runtime id (`sub:<task_id>` or raw task id)."""
        async with self._lifecycle_lock:
            task_id = self._normalize_subagent_task_id(subagent_id)
            if not task_id:
                return False
            return await self._embedded.agent.subagents.cancel_task(task_id)

    def get_status(self, agent_id: str) -> ManagedAgentStatus | None:
        """Return status for one runtime agent id."""
        normalized = agent_id.strip()
        if normalized in {"main", self.main_agent_id}:
            return self._main_status()
        task_id = self._normalize_subagent_task_id(normalized)
        if not task_id:
            return None
        st = self._embedded.agent.subagents.get_task_status(task_id)
        if st is None:
            return None
        return self._to_subagent_status(st)

    def list_statuses(self) -> list[ManagedAgentStatus]:
        """List runtime statuses for main + all tracked subagents."""
        rows = [self._main_status()]
        for st in self._embedded.agent.subagents.list_task_statuses(include_finished=True):
            rows.append(self._to_subagent_status(st))
        rows.sort(key=lambda row: row.started_at or 0.0, reverse=True)
        return rows

    def _main_status(self) -> ManagedAgentStatus:
        started_at = None
        uptime = None
        if self._is_main_running():
            now = time.monotonic()
            start_perf = getattr(self._embedded, "_start_perf", 0.0) or 0.0
            if start_perf > 0:
                started_at = start_perf
                uptime = round(now - start_perf, 3)
        return ManagedAgentStatus(
            agent_id=self.main_agent_id,
            role="main",
            running=self._is_main_running(),
            phase="running" if self._is_main_running() else "stopped",
            started_at=started_at,
            uptime_seconds=uptime,
        )

    @staticmethod
    def _normalize_subagent_task_id(value: str) -> str | None:
        raw = (value or "").strip()
        if not raw:
            return None
        if raw.startswith("sub:"):
            raw = raw[4:]
        return raw or None

    def _to_subagent_status(self, st: Any) -> ManagedAgentStatus:
        task_id = str(getattr(st, "task_id", "")).strip()
        started_at = getattr(st, "started_at", None)
        completed_at = getattr(st, "completed_at", None)
        running = self._embedded.agent.subagents.is_task_running(task_id)
        uptime = None
        if isinstance(started_at, (int, float)):
            end = time.monotonic() if running else completed_at
            if isinstance(end, (int, float)) and end >= started_at:
                uptime = round(end - started_at, 3)
        return ManagedAgentStatus(
            agent_id=f"sub:{task_id}",
            role="sub",
            running=running,
            phase=getattr(st, "phase", None),
            started_at=started_at,
            uptime_seconds=uptime,
            parent_agent_id=getattr(st, "parent_agent_id", None),
            team_id=getattr(st, "team_id", None),
            label=getattr(st, "label", None),
            task_description=getattr(st, "task_description", None),
            iteration=getattr(st, "iteration", None),
            stop_reason=getattr(st, "stop_reason", None),
            error=getattr(st, "error", None),
            session_key=getattr(st, "session_key", None),
            parent_session_key=getattr(st, "parent_session_key", None),
            profile_id=getattr(st, "profile_id", None),
        )

