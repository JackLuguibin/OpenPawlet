"""UnifiedAgentManager.list_statuses surfaces idle profile rows.

Regression test for the "新建智能体" + "运行管理" flow: profiles created
via the Console Agents page must appear in the runtime manager listing
even before they have ever been spawned, so the user can see and start
them from the dashboard.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from openpawlet.agent.profile_resolver import ProfileStore
from openpawlet.agent.subagent import SubagentManager
from openpawlet.bus.queue import MessageBus
from openpawlet.config.profile import AgentProfile
from openpawlet.config.schema import AgentDefaults, ExecToolConfig, ToolsConfig
from openpawlet.runtime.agent_manager import UnifiedAgentManager

_MAX_TOOL_RESULT_CHARS = AgentDefaults().max_tool_result_chars


def _build_subagent_manager(workspace: Path) -> SubagentManager:
    bus = MessageBus()
    provider = MagicMock()
    provider.get_default_model.return_value = "main-model"
    return SubagentManager(
        provider=provider,
        workspace=workspace,
        bus=bus,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
        exec_config=ExecToolConfig(),
        base_defaults=AgentDefaults(model="main-model"),
        base_tools=ToolsConfig(),
    )


def _fake_embedded(
    subagents: SubagentManager,
    *,
    standalone_tasks: dict[str, object] | None = None,
    team_loops: dict[str, object] | None = None,
    team_tasks: dict[str, object] | None = None,
    team_bindings: dict[str, tuple[str, str, str, str]] | None = None,
    team_primary_session_by_agent: dict[str, str] | None = None,
) -> SimpleNamespace:
    """Minimal stand-in for ``EmbeddedOpenPawlet`` used by ``UnifiedAgentManager``."""
    agent = SimpleNamespace(agent_id="main", subagents=subagents, _running=False)
    return SimpleNamespace(
        agent=agent,
        _tasks=[],
        _stopping=False,
        _start_perf=0.0,
        _standalone_tasks_by_agent=dict(standalone_tasks or {}),
        _team_loops_by_agent=dict(team_loops or {}),
        _team_tasks_by_agent=dict(team_tasks or {}),
        _team_bindings_by_session=dict(team_bindings or {}),
        _team_primary_session_by_agent=dict(team_primary_session_by_agent or {}),
    )


def test_list_statuses_includes_persisted_profile_rows(tmp_path: Path) -> None:
    """Profiles saved on disk should appear as ``role='profile'`` idle rows."""
    ProfileStore(tmp_path).save(
        AgentProfile(id="researcher", name="Researcher", description="reads code")
    )
    ProfileStore(tmp_path).save(AgentProfile(id="writer", name="Writer"))

    subagents = _build_subagent_manager(tmp_path)
    manager = UnifiedAgentManager(_fake_embedded(subagents))  # type: ignore[arg-type]

    rows = manager.list_statuses()
    profile_rows = {r.profile_id: r for r in rows if r.role == "profile"}

    assert set(profile_rows.keys()) == {"researcher", "writer"}
    researcher = profile_rows["researcher"]
    assert researcher.agent_id == "profile:researcher"
    assert researcher.running is False
    assert researcher.phase == "idle"
    assert researcher.label == "Researcher"
    assert researcher.task_description == "reads code"


@pytest.mark.asyncio
async def test_running_subagent_hides_idle_profile_row(tmp_path: Path) -> None:
    """Once a profile has a tracked sub-agent run, the idle row is suppressed."""
    ProfileStore(tmp_path).save(AgentProfile(id="busy", name="Busy"))

    subagents = _build_subagent_manager(tmp_path)
    # Stub the runner so spawn_task completes without invoking a real LLM.
    from unittest.mock import AsyncMock

    async def _fake_run(spec):  # noqa: ANN001
        return SimpleNamespace(
            stop_reason="done", final_content="ok", error=None, tool_events=[]
        )

    subagents.runner.run = AsyncMock(side_effect=_fake_run)
    subagents._announce_result = AsyncMock()

    task_id = await subagents.spawn_task(
        task="run analysis",
        profile_id="busy",
        origin_channel="cli",
        origin_chat_id="direct",
    )
    await subagents._running_tasks[task_id]

    manager = UnifiedAgentManager(_fake_embedded(subagents))  # type: ignore[arg-type]
    rows = manager.list_statuses()

    profile_only_rows = [r for r in rows if r.role == "profile"]
    sub_rows = [r for r in rows if r.role == "sub"]

    assert profile_only_rows == []
    assert any(r.profile_id == "busy" for r in sub_rows)


def test_get_status_supports_profile_prefix(tmp_path: Path) -> None:
    """``get_status('profile:<id>')`` returns the idle persona row."""
    ProfileStore(tmp_path).save(AgentProfile(id="solo", name="Solo"))

    subagents = _build_subagent_manager(tmp_path)
    manager = UnifiedAgentManager(_fake_embedded(subagents))  # type: ignore[arg-type]

    row = manager.get_status("profile:solo")
    assert row is not None
    assert row.role == "profile"
    assert row.profile_id == "solo"
    assert row.running is False

    assert manager.get_status("profile:missing") is None


# ---------------------------------------------------------------------------
# Standalone (enabled = running) agent rows
# ---------------------------------------------------------------------------


def test_standalone_agent_rows_show_running_state(tmp_path: Path) -> None:
    """Embedded standalone tasks should appear as ``role='agent'`` running rows."""
    ProfileStore(tmp_path).save(AgentProfile(id="alpha", name="Alpha"))
    ProfileStore(tmp_path).save(AgentProfile(id="beta", name="Beta"))

    subagents = _build_subagent_manager(tmp_path)
    # Stub asyncio tasks: a not-done one for "alpha" (running) and a done
    # one for "beta" (treated as stopped). The manager only checks .done().
    alpha_task = SimpleNamespace(done=lambda: False)
    beta_task = SimpleNamespace(done=lambda: True)

    manager = UnifiedAgentManager(  # type: ignore[arg-type]
        _fake_embedded(
            subagents,
            standalone_tasks={"alpha": alpha_task, "beta": beta_task},
        )
    )

    rows = manager.list_statuses()
    by_role: dict[str, list] = {}
    for r in rows:
        by_role.setdefault(r.role, []).append(r)

    agent_rows = {r.profile_id: r for r in by_role.get("agent", [])}
    assert set(agent_rows.keys()) == {"alpha", "beta"}
    assert agent_rows["alpha"].running is True
    assert agent_rows["alpha"].agent_id == "agent:alpha"
    assert agent_rows["alpha"].label == "Alpha"
    assert agent_rows["alpha"].session_key == "console:agent_alpha"
    assert agent_rows["beta"].running is False

    # The running standalone agent must hide the duplicate idle row, the
    # stopped one should NOT (we still want to surface idle profiles).
    profile_rows = {r.profile_id: r for r in by_role.get("profile", [])}
    assert "alpha" not in profile_rows
    assert "beta" not in profile_rows


def test_get_status_supports_agent_prefix(tmp_path: Path) -> None:
    """``get_status('agent:<id>')`` returns the standalone running row."""
    ProfileStore(tmp_path).save(AgentProfile(id="solo", name="Solo"))
    subagents = _build_subagent_manager(tmp_path)
    task = SimpleNamespace(done=lambda: False)

    manager = UnifiedAgentManager(  # type: ignore[arg-type]
        _fake_embedded(subagents, standalone_tasks={"solo": task})
    )

    row = manager.get_status("agent:solo")
    assert row is not None
    assert row.role == "agent"
    assert row.profile_id == "solo"
    assert row.running is True

    assert manager.get_status("agent:missing") is None


# ---------------------------------------------------------------------------
# EmbeddedOpenPawlet._list_enabled_standalone_agents — selection rules
# ---------------------------------------------------------------------------


def test_list_enabled_standalone_agents_skips_disabled_and_team_members(
    tmp_path: Path,
) -> None:
    """Disabled profiles + team-bound + primary agent must be excluded."""
    from openpawlet.runtime.embedded import EmbeddedOpenPawlet

    ProfileStore(tmp_path).save(AgentProfile(id="enabled-1", name="One", enabled=True))
    ProfileStore(tmp_path).save(
        AgentProfile(id="enabled-2", name="Two", enabled=True)
    )
    ProfileStore(tmp_path).save(
        AgentProfile(id="disabled-1", name="Off", enabled=False)
    )
    ProfileStore(tmp_path).save(
        AgentProfile(id="team-member", name="TeamMember", enabled=True)
    )
    ProfileStore(tmp_path).save(
        AgentProfile(id="main-agent", name="Main", enabled=True)
    )

    embedded = SimpleNamespace(
        _config=SimpleNamespace(workspace_path=tmp_path),
        _team_loops_by_agent={"team-member": object()},
        _primary_aid="main-agent",
    )
    result = EmbeddedOpenPawlet._list_enabled_standalone_agents(embedded)  # type: ignore[arg-type]
    assert result == ["enabled-1", "enabled-2"]


def test_agent_profile_enabled_defaults_true_for_legacy_files(
    tmp_path: Path,
) -> None:
    """Profile.json without enabled key should still load with enabled=True."""
    import json

    profile_path = tmp_path / "agents" / "legacy" / "profile.json"
    profile_path.parent.mkdir(parents=True, exist_ok=True)
    profile_path.write_text(
        json.dumps({"id": "legacy", "name": "Legacy"}), encoding="utf-8"
    )

    profiles = ProfileStore(tmp_path).list_profiles()
    assert len(profiles) == 1
    assert profiles[0].id == "legacy"
    assert profiles[0].enabled is True


def test_console_agent_payload_round_trips_through_profile_store(
    tmp_path: Path,
) -> None:
    """Profile.json written by the Console Agents page must keep enabled=False."""
    import json

    profile_path = tmp_path / "agents" / "console" / "profile.json"
    profile_path.parent.mkdir(parents=True, exist_ok=True)
    # Mirrors the exact shape Console writes (extra fields like ``topics``
    # / ``created_at`` get ignored by AgentProfile but must not break load).
    profile_path.write_text(
        json.dumps(
            {
                "id": "console",
                "name": "FromConsole",
                "description": None,
                "model": "deepseek-v3.2",
                "temperature": None,
                "system_prompt": "you are helpful",
                "skills": [],
                "topics": ["events.demo"],
                "collaborators": [],
                "enabled": False,
                "created_at": "2026-04-28T00:00:00Z",
            }
        ),
        encoding="utf-8",
    )

    profiles = ProfileStore(tmp_path).list_profiles()
    assert len(profiles) == 1
    assert profiles[0].id == "console"
    assert profiles[0].name == "FromConsole"
    assert profiles[0].enabled is False
    assert profiles[0].model == "deepseek-v3.2"


def test_profile_fingerprint_changes_when_runtime_fields_change(
    tmp_path: Path,
) -> None:
    """Editing model / system_prompt / skills must change the fingerprint.

    Reconciler relies on this to know when to rebuild a standalone loop
    so the user's edits in the Agents page actually take effect.
    """
    from openpawlet.runtime.embedded import EmbeddedOpenPawlet

    embedded = SimpleNamespace(_config=SimpleNamespace(workspace_path=tmp_path))
    base = AgentProfile(id="x", name="X", model="m1", system_prompt="hi")
    fp_before = EmbeddedOpenPawlet._profile_fingerprint(embedded, base)  # type: ignore[arg-type]

    # Same content -> same fingerprint.
    same = AgentProfile(id="x", name="X-renamed", model="m1", system_prompt="hi")
    fp_same = EmbeddedOpenPawlet._profile_fingerprint(embedded, same)  # type: ignore[arg-type]
    assert fp_before == fp_same  # name change must NOT trigger rebuild

    changed_model = AgentProfile(id="x", name="X", model="m2", system_prompt="hi")
    assert EmbeddedOpenPawlet._profile_fingerprint(embedded, changed_model) != fp_before  # type: ignore[arg-type]

    changed_prompt = AgentProfile(
        id="x", name="X", model="m1", system_prompt="bye"
    )
    assert EmbeddedOpenPawlet._profile_fingerprint(embedded, changed_prompt) != fp_before  # type: ignore[arg-type]

    changed_skills = AgentProfile(
        id="x", name="X", model="m1", system_prompt="hi", skills=["alpha"]
    )
    assert EmbeddedOpenPawlet._profile_fingerprint(embedded, changed_skills) != fp_before  # type: ignore[arg-type]


def test_team_member_loops_show_as_running_agent_rows(tmp_path: Path) -> None:
    """Agents inside a team must appear as running ``role='agent'`` rows.

    Regression: before this fix the team-member loop existed in
    ``_team_loops_by_agent`` but ``list_statuses`` ignored it, so the
    runtime UI displayed the agent as an "idle profile" even though
    the loop was clearly running.
    """
    ProfileStore(tmp_path).save(
        AgentProfile(id="team-mate", name="Mate", description="t1")
    )
    subagents = _build_subagent_manager(tmp_path)
    sk = "console:team_T1_room_R1_agent_team-mate"
    task = SimpleNamespace(done=lambda: False)

    manager = UnifiedAgentManager(  # type: ignore[arg-type]
        _fake_embedded(
            subagents,
            team_loops={"team-mate": object()},
            team_tasks={"team-mate": task},
            team_bindings={sk: ("T1", "R1", "team-mate", sk)},
            team_primary_session_by_agent={"team-mate": sk},
        )
    )

    rows = manager.list_statuses()
    by_role: dict[str, list] = {}
    for r in rows:
        by_role.setdefault(r.role, []).append(r)

    agent_rows = {r.profile_id: r for r in by_role.get("agent", [])}
    assert "team-mate" in agent_rows
    row = agent_rows["team-mate"]
    assert row.running is True
    assert row.team_id == "T1"
    assert row.session_key == sk
    assert row.label == "Mate"

    # Idle profile row must be suppressed for the running team agent.
    profile_ids = [r.profile_id for r in by_role.get("profile", [])]
    assert "team-mate" not in profile_ids


def test_disabled_profile_idle_row_phase_is_disabled(tmp_path: Path) -> None:
    """Disabled profiles still show in runtime list, but tagged ``phase='disabled'``."""
    ProfileStore(tmp_path).save(
        AgentProfile(id="off-1", name="Off", enabled=False)
    )

    subagents = _build_subagent_manager(tmp_path)
    manager = UnifiedAgentManager(_fake_embedded(subagents))  # type: ignore[arg-type]

    rows = manager.list_statuses()
    profile_rows = [r for r in rows if r.role == "profile"]
    assert len(profile_rows) == 1
    assert profile_rows[0].profile_id == "off-1"
    assert profile_rows[0].running is False
    assert profile_rows[0].phase == "disabled"


def test_list_statuses_suppresses_duplicate_main_when_standalone_profile_matches_gateway(
    tmp_path: Path,
) -> None:
    """``main:<host>`` plus ``agent:main`` should collapse to one gateway surrogate row."""

    ProfileStore(tmp_path).save(AgentProfile(id="main", name="Default"))
    subagents = _build_subagent_manager(tmp_path)
    task = SimpleNamespace(done=lambda: False)
    emb = _fake_embedded(subagents, standalone_tasks={"main": task})
    emb.agent.agent_id = "main:jk-pc:145324"
    emb.agent._running = True

    manager = UnifiedAgentManager(emb)  # type: ignore[arg-type]
    rows = manager.list_statuses()

    assert all(r.role != "main" for r in rows)
    gate = next(r for r in rows if r.agent_id == "agent:main")
    assert gate.represents_gateway is True


def test_list_statuses_keeps_main_when_standalone_main_idle(tmp_path: Path) -> None:
    """Stopped standalone loop must not hide the running gateway row."""

    ProfileStore(tmp_path).save(AgentProfile(id="main", name="Default"))
    subagents = _build_subagent_manager(tmp_path)
    idle_task = SimpleNamespace(done=lambda: True)
    emb = _fake_embedded(subagents, standalone_tasks={"main": idle_task})
    emb.agent.agent_id = "main:jk-pc:145324"
    emb.agent._running = True

    manager = UnifiedAgentManager(emb)  # type: ignore[arg-type]
    rows = manager.list_statuses()

    assert any(r.role == "main" for r in rows)
    dup = next(r for r in rows if r.agent_id == "agent:main")
    assert dup.represents_gateway is False
