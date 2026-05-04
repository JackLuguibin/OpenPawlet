"""Unified runtime manager for main/sub agent lifecycle and status."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from openpawlet.runtime.embedded import EmbeddedOpenPawlet


@dataclass(slots=True)
class ManagedAgentStatus:
    """Normalized runtime status payload for API consumption."""

    agent_id: str
    role: str  # main | sub | profile | agent
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
    # (see :class:`openpawlet.config.profile.AgentProfile`).
    profile_id: str | None = None
    # True when this ``role="agent"`` row duplicates the gateway loop listing:
    # the supervisor exposes ``agent:<profile_id>`` while ``OPENPAWLET_AGENT_ID``
    # may use a distinct id (historically ``main:<host>:<pid>``); default is ``agent:main``.
    represents_gateway: bool = False


_STOP_TIMEOUT_S = 10.0


class UnifiedAgentManager:
    """Manage runtime lifecycle for the primary agent and subagents."""

    def __init__(self, embedded: EmbeddedOpenPawlet) -> None:
        self._embedded = embedded
        # Serialise all start/stop control-plane operations so concurrent
        # callers cannot race two agent loops on the same bus or tear down
        # while another caller is still spawning.
        self._lifecycle_lock = asyncio.Lock()

    def _workspace_path(self) -> Path | None:
        cfg = getattr(self._embedded, "_config", None)
        wp = getattr(cfg, "workspace_path", None)
        if isinstance(wp, Path):
            return wp
        subs = getattr(getattr(self._embedded, "agent", None), "subagents", None)
        wp2 = getattr(subs, "workspace", None)
        return wp2 if isinstance(wp2, Path) else None

    def _logical_gateway_profile_id(self) -> str | None:
        wp = self._workspace_path()
        if wp is None:
            return None
        from openpawlet.utils.team_gateway_runtime import resolve_effective_gateway_agent_id

        return resolve_effective_gateway_agent_id(wp)

    def _gateway_surrogate_agent_row(
        self,
        standalone_rows: list[ManagedAgentStatus],
        team_rows: list[ManagedAgentStatus],
    ) -> ManagedAgentStatus | None:
        """Return standalone/team agent row that duplicates an active gateway loop."""

        if not self._is_main_running():
            return None
        logical = self._logical_gateway_profile_id()
        primary = self.main_agent_id

        def _duplicate_persona(pid: str) -> bool:
            if logical:
                return pid == logical
            # Fallback when workspace identity inference fails (e.g. nested
            # ``agents/<id>/profile.json`` vs flat *.json discovery mismatch).
            return pid == "main" and primary not in ("", "main")

        for coll in (standalone_rows, team_rows):
            for row in coll:
                pid = (row.profile_id or "").strip()
                if pid and row.running and _duplicate_persona(pid):
                    return row
        return None

    @property
    def main_agent_id(self) -> str:
        return str(getattr(self._embedded.agent, "agent_id", "") or "main")

    def _main_agent_task(self) -> asyncio.Task[Any] | None:
        for task in list(getattr(self._embedded, "_tasks", [])):
            if task.get_name() == "openpawlet-agent-run":
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
            task = asyncio.create_task(self._embedded.agent.run(), name="openpawlet-agent-run")
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
        """Return status for one runtime agent id.

        Supports ``main`` / the gateway agent id, ``sub:<task_id>``,
        ``agent:<profile_id>`` (standalone enabled persona loop) and
        ``profile:<profile_id>`` (idle persona surfaced for the runtime UI).
        """
        normalized = agent_id.strip()
        if normalized in {"main", self.main_agent_id}:
            return self._main_status()
        if normalized.startswith("agent:"):
            aid = normalized[len("agent:"):].strip()
            if not aid:
                return None
            for row in self._team_member_agent_rows():
                if row.profile_id == aid:
                    return row
            for row in self._standalone_agent_rows():
                if row.profile_id == aid:
                    return row
            return None
        if normalized.startswith("profile:"):
            pid = normalized[len("profile:"):].strip()
            if not pid:
                return None
            for row in self._idle_profile_rows(exclude=set()):
                if row.profile_id == pid:
                    return row
            return None
        task_id = self._normalize_subagent_task_id(normalized)
        if not task_id:
            return None
        st = self._embedded.agent.subagents.get_task_status(task_id)
        if st is None:
            return None
        return self._to_subagent_status(st)

    def list_statuses(self) -> list[ManagedAgentStatus]:
        """List runtime statuses for main + tracked subagents + standalone agents.

        - ``role="main"``: the gateway / primary agent (may be omitted when an
          ``agent:<resolved_workspace_identity>`` row duplicates its lifecycle).
        - ``role="sub"``: one-shot tracked sub-agent task (past or live).
        - ``role="agent"``: an *enabled* persisted profile with its own
          standalone event loop (the "enable = running" semantics).
        - ``role="profile"``: a persisted profile that is not currently
          running (disabled, or no standalone loop spawned yet) — kept so
          the user can still see and trigger it from the runtime UI.
        """
        standalone_rows = self._standalone_agent_rows()
        team_rows = self._team_member_agent_rows()
        surrogate = self._gateway_surrogate_agent_row(standalone_rows, team_rows)
        surrogate_pid: str | None = None
        if surrogate is not None:
            sp = (surrogate.profile_id or "").strip()
            if sp:
                surrogate_pid = sp

        rows: list[ManagedAgentStatus] = []
        if surrogate_pid is None:
            rows.append(self._main_status())
        # Track profile ids that are already represented by a live
        # sub-agent task, a team member loop, or a standalone loop so we
        # don't duplicate the idle row for them.
        profile_ids_seen: set[str] = set()
        for st in self._embedded.agent.subagents.list_task_statuses(include_finished=True):
            sub_row = self._to_subagent_status(st)
            rows.append(sub_row)
            if sub_row.profile_id:
                profile_ids_seen.add(sub_row.profile_id)

        for team_row in team_rows:
            out_row = (
                replace(team_row, represents_gateway=True)
                if surrogate_pid and team_row.profile_id == surrogate_pid
                else team_row
            )
            rows.append(out_row)
            if team_row.profile_id:
                profile_ids_seen.add(team_row.profile_id)

        for standalone in standalone_rows:
            out_row = (
                replace(standalone, represents_gateway=True)
                if surrogate_pid and standalone.profile_id == surrogate_pid
                else standalone
            )
            rows.append(out_row)
            if standalone.profile_id:
                profile_ids_seen.add(standalone.profile_id)

        rows.extend(self._idle_profile_rows(exclude=profile_ids_seen))
        rows.sort(key=lambda row: row.started_at or 0.0, reverse=True)
        return rows

    def _team_member_agent_rows(self) -> list[ManagedAgentStatus]:
        """Return one ``role="agent"`` row per running team-member loop.

        Mirrors :meth:`_standalone_agent_rows` but reads from
        ``EmbeddedOpenPawlet._team_loops_by_agent`` /
        ``_team_tasks_by_agent``. From the user's perspective both are
        just "the agent is running" — only the session_key differs.
        """
        loops: dict[str, Any] = getattr(
            self._embedded, "_team_loops_by_agent", {}
        ) or {}
        tasks: dict[str, Any] = getattr(
            self._embedded, "_team_tasks_by_agent", {}
        ) or {}
        bindings: dict[str, tuple[str, str, str, str]] = getattr(
            self._embedded, "_team_bindings_by_session", {}
        ) or {}
        primary_session_by_agent: dict[str, str] = getattr(
            self._embedded, "_team_primary_session_by_agent", {}
        ) or {}
        if not loops:
            return []

        store = getattr(self._embedded.agent.subagents, "profile_store", None)
        profile_by_id: dict[str, Any] = {}
        if store is not None:
            try:
                for profile in store.list_profiles():
                    profile_by_id[profile.id] = profile
            except Exception:  # pragma: no cover - defensive
                profile_by_id = {}

        # Map agent_id -> team_id from the team bindings tuple.
        team_id_by_agent: dict[str, str] = {}
        for _sk, binding in bindings.items():
            tid, _rid, aid, _full = binding
            team_id_by_agent.setdefault(aid, tid)

        start_perf = getattr(self._embedded, "_start_perf", 0.0) or 0.0
        now = time.monotonic()
        rows: list[ManagedAgentStatus] = []
        for aid in loops.keys():
            task = tasks.get(aid)
            running = bool(task is not None and not task.done())
            profile = profile_by_id.get(aid)
            sk = primary_session_by_agent.get(aid)
            uptime = round(now - start_perf, 3) if running and start_perf > 0 else None
            rows.append(
                ManagedAgentStatus(
                    agent_id=f"agent:{aid}",
                    role="agent",
                    running=running,
                    phase="running" if running else "stopped",
                    started_at=start_perf if running else None,
                    uptime_seconds=uptime,
                    team_id=team_id_by_agent.get(aid),
                    label=(profile.name if profile else aid),
                    task_description=(profile.description if profile else None),
                    session_key=sk,
                    profile_id=aid,
                )
            )
        return rows

    def _standalone_agent_rows(self) -> list[ManagedAgentStatus]:
        """Return one ``role="agent"`` row per running standalone agent loop."""
        tasks: dict[str, Any] = getattr(
            self._embedded, "_standalone_tasks_by_agent", {}
        ) or {}
        if not tasks:
            return []
        store = getattr(self._embedded.agent.subagents, "profile_store", None)
        profile_by_id: dict[str, Any] = {}
        if store is not None:
            try:
                for profile in store.list_profiles():
                    profile_by_id[profile.id] = profile
            except Exception:  # pragma: no cover - defensive
                profile_by_id = {}

        start_perf = getattr(self._embedded, "_start_perf", 0.0) or 0.0
        now = time.monotonic()
        rows: list[ManagedAgentStatus] = []
        for aid, task in tasks.items():
            running = bool(task is not None and not task.done())
            profile = profile_by_id.get(aid)
            from openpawlet.utils.team_gateway_runtime import standalone_agent_session_key

            sk = standalone_agent_session_key(aid)
            uptime = round(now - start_perf, 3) if running and start_perf > 0 else None
            rows.append(
                ManagedAgentStatus(
                    agent_id=f"agent:{aid}",
                    role="agent",
                    running=running,
                    phase="running" if running else "stopped",
                    started_at=start_perf if running else None,
                    uptime_seconds=uptime,
                    label=(profile.name if profile else aid),
                    task_description=(profile.description if profile else None),
                    session_key=sk,
                    profile_id=aid,
                )
            )
        return rows

    def _idle_profile_rows(self, *, exclude: set[str]) -> list[ManagedAgentStatus]:
        """Return one ``role="profile"`` row per persisted profile not in *exclude*.

        Disabled profiles are surfaced too (so users can still see and
        "start" them from the runtime UI as a one-shot sub-agent), but
        we tag them ``phase="disabled"`` to make it obvious they are not
        being kept alive by the runtime reconciler.
        """
        store = getattr(self._embedded.agent.subagents, "profile_store", None)
        if store is None:
            return []
        try:
            profiles = store.list_profiles()
        except Exception:  # pragma: no cover - defensive: bad fs entries
            return []
        rows: list[ManagedAgentStatus] = []
        for profile in profiles:
            pid = (profile.id or "").strip()
            if not pid or pid in exclude:
                continue
            rows.append(
                ManagedAgentStatus(
                    agent_id=f"profile:{pid}",
                    role="profile",
                    running=False,
                    phase="disabled" if not profile.enabled else "idle",
                    label=profile.name or pid,
                    task_description=profile.description,
                    profile_id=pid,
                )
            )
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

