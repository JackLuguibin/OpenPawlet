"""Sub-agent profile integration: spawn(profile=...) and tool whitelist."""

from __future__ import annotations

import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from openpawlet.agent.profile_resolver import ProfileStore, resolve_profile
from openpawlet.agent.subagent import SubagentManager, SubagentStatus
from openpawlet.agent.tools.errors import AgentToolAbort
from openpawlet.bus.queue import MessageBus
from openpawlet.config.profile import (
    AgentDefaultsOverride,
    AgentProfile,
    ExecToolOverride,
    ToolsConfigOverride,
)
from openpawlet.config.schema import AgentDefaults, ExecToolConfig, ToolsConfig

_MAX_TOOL_RESULT_CHARS = AgentDefaults().max_tool_result_chars


def _mgr(workspace: Path) -> SubagentManager:
    bus = MessageBus()
    provider = MagicMock()
    provider.get_default_model.return_value = "main-model"
    return SubagentManager(
        provider=provider,
        workspace=workspace,
        bus=bus,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
        exec_config=ExecToolConfig(),
        base_defaults=AgentDefaults(model="main-model", max_tokens=8000),
        base_tools=ToolsConfig(),
    )


def _save_profile(workspace: Path, profile: AgentProfile) -> None:
    ProfileStore(workspace).save(profile)


@pytest.mark.asyncio
async def test_spawn_without_profile_uses_main_model(tmp_path: Path) -> None:
    mgr = _mgr(tmp_path)
    mgr._announce_result = AsyncMock()
    captured: dict[str, object] = {}

    async def fake_run(spec):
        captured["model"] = spec.model
        captured["tool_names"] = sorted(spec.tools.tool_names)
        return SimpleNamespace(stop_reason="done", final_content="ok", error=None, tool_events=[])

    mgr.runner.run = AsyncMock(side_effect=fake_run)

    status = SubagentStatus(
        task_id="sub-noprof",
        label="lbl",
        task_description="task",
        started_at=time.monotonic(),
    )
    await mgr._run_subagent(
        "sub-noprof",
        "do work",
        "lbl",
        {"channel": "cli", "chat_id": "direct"},
        status,
        None,
    )
    assert captured["model"] == "main-model"
    # No whitelist applied → all default tools registered.
    assert "read_file" in captured["tool_names"]
    assert "exec" in captured["tool_names"]


@pytest.mark.asyncio
async def test_spawn_with_profile_overrides_model_and_tools(tmp_path: Path) -> None:
    profile = AgentProfile(
        id="researcher",
        name="Researcher",
        overrides=AgentDefaultsOverride(model="profile-model", max_tokens=2000),
        allowed_tools=["read_file", "grep", "glob"],
    )
    _save_profile(tmp_path, profile)

    mgr = _mgr(tmp_path)
    mgr._announce_result = AsyncMock()
    captured: dict[str, object] = {}

    async def fake_run(spec):
        captured["model"] = spec.model
        captured["tool_names"] = sorted(spec.tools.tool_names)
        return SimpleNamespace(stop_reason="done", final_content="ok", error=None, tool_events=[])

    mgr.runner.run = AsyncMock(side_effect=fake_run)

    task_id = await mgr.spawn_task(
        task="run analysis",
        profile_id="researcher",
        origin_channel="cli",
        origin_chat_id="direct",
    )
    # Wait for the background task to complete.
    bg = mgr._running_tasks[task_id]
    await bg

    assert captured["model"] == "profile-model"
    assert captured["tool_names"] == ["glob", "grep", "read_file"]


@pytest.mark.asyncio
async def test_profile_can_disable_exec(tmp_path: Path) -> None:
    profile = AgentProfile(
        id="safe",
        name="Safe",
        tools_overrides=ToolsConfigOverride(exec=ExecToolOverride(enable=False)),
    )
    _save_profile(tmp_path, profile)

    mgr = _mgr(tmp_path)
    mgr._announce_result = AsyncMock()
    captured: dict[str, object] = {}

    async def fake_run(spec):
        captured["tool_names"] = sorted(spec.tools.tool_names)
        return SimpleNamespace(stop_reason="done", final_content="ok", error=None, tool_events=[])

    mgr.runner.run = AsyncMock(side_effect=fake_run)

    task_id = await mgr.spawn_task(
        task="task",
        profile_id="safe",
        origin_channel="cli",
        origin_chat_id="direct",
    )
    await mgr._running_tasks[task_id]
    assert "exec" not in captured["tool_names"]
    assert "read_file" in captured["tool_names"]


@pytest.mark.asyncio
async def test_unknown_profile_raises(tmp_path: Path) -> None:
    mgr = _mgr(tmp_path)
    with pytest.raises(ValueError):
        await mgr.spawn_task(
            task="x",
            profile_id="missing",
            origin_channel="cli",
            origin_chat_id="direct",
        )


@pytest.mark.asyncio
async def test_profile_status_records_profile_id(tmp_path: Path) -> None:
    profile = AgentProfile(id="hello", name="Hello")
    _save_profile(tmp_path, profile)

    mgr = _mgr(tmp_path)
    mgr._announce_result = AsyncMock()

    async def fake_run(spec):
        return SimpleNamespace(stop_reason="done", final_content="ok", error=None, tool_events=[])

    mgr.runner.run = AsyncMock(side_effect=fake_run)

    task_id = await mgr.spawn_task(
        task="task",
        profile_id="hello",
        origin_channel="cli",
        origin_chat_id="direct",
    )
    await mgr._running_tasks[task_id]
    assert mgr.get_task_status(task_id).profile_id == "hello"


@pytest.mark.asyncio
async def test_inline_profile_does_not_persist_profile_json(tmp_path: Path) -> None:
    """Inline profiles should not materialise ``profile.json`` on disk.

    The per-agent sandbox directory is allowed (and required) to exist so
    file/exec tools have a hard boundary to operate within, but the
    ``profile.json`` file is reserved for ``ProfileStore.save`` callers.
    """
    mgr = _mgr(tmp_path)
    mgr._announce_result = AsyncMock()
    captured: dict[str, object] = {}

    async def fake_run(spec):
        captured["model"] = spec.model
        return SimpleNamespace(stop_reason="done", final_content="ok", error=None, tool_events=[])

    mgr.runner.run = AsyncMock(side_effect=fake_run)

    profile = AgentProfile(
        id="ad-hoc",
        name="Ad-hoc",
        overrides=AgentDefaultsOverride(model="ephemeral-m"),
    )
    task_id = await mgr.spawn_task(
        task="task",
        profile_inline=profile,
        origin_channel="cli",
        origin_chat_id="direct",
    )
    await mgr._running_tasks[task_id]
    assert captured["model"] == "ephemeral-m"
    # Inline profile must not persist its config file (only the sandbox dir).
    assert not (tmp_path / "agents" / "ad-hoc" / "profile.json").exists()


# ---------------------------------------------------------------------------
# Sandbox boundary tests — profile-driven sub-agents are locked to their own
# ``<workspace>/agents/<id>/`` directory and cannot reach into the main bot
# workspace or escape into the broader filesystem.
# ---------------------------------------------------------------------------


def _build_resolved(workspace: Path, profile: AgentProfile):
    """Helper: resolve *profile* against a default base for tool tests."""
    return resolve_profile(
        profile,
        base_defaults=AgentDefaults(model="m"),
        base_tools=ToolsConfig(),
        workspace=workspace,
    )


def test_profile_subagent_filesystem_locked_to_agent_dir(tmp_path: Path) -> None:
    """File tools must reject paths outside ``<workspace>/agents/<id>/``."""
    profile = AgentProfile(id="boxed", name="Boxed")
    mgr = _mgr(tmp_path)
    resolved = _build_resolved(tmp_path, profile)
    tools = mgr._build_subagent_tools(
        task_id="t1",
        origin={"channel": "cli", "chat_id": "direct"},
        resolved=resolved,
    )

    write_file = tools.get("write_file")
    agent_root = tmp_path / "agents" / "boxed"
    agent_root.mkdir(parents=True, exist_ok=True)

    # A pre-existing file just outside the sandbox we will try (and fail) to
    # overwrite from inside the sub-agent.
    (tmp_path / "secret.txt").write_text("top-secret", encoding="utf-8")

    import asyncio

    async def _try_writes():
        ok = await write_file.execute(path="note.txt", content="hi")
        with pytest.raises(AgentToolAbort, match="outside allowed directory"):
            await write_file.execute(path="../../secret.txt", content="hijacked")
        with pytest.raises(AgentToolAbort, match="outside allowed directory"):
            await write_file.execute(path=str(tmp_path / "secret.txt"), content="hijacked")
        return ok

    ok = asyncio.run(_try_writes())

    # In-sandbox write succeeded.
    assert "Error" not in str(ok), ok
    assert (agent_root / "note.txt").read_text(encoding="utf-8") == "hi"
    # Out-of-sandbox attempts must be refused and leave the original file intact.
    assert (tmp_path / "secret.txt").read_text(encoding="utf-8") == "top-secret"


def test_profile_cannot_relax_sandbox_via_restrict_flag(tmp_path: Path) -> None:
    """``restrict_to_workspace=False`` on the profile must NOT widen the sandbox."""
    profile = AgentProfile(
        id="loose",
        name="Loose",
        tools_overrides=ToolsConfigOverride(restrict_to_workspace=False),
    )
    mgr = _mgr(tmp_path)
    resolved = _build_resolved(tmp_path, profile)
    # Even though the profile asks for an unrestricted workspace, the manager
    # forces a per-agent sandbox.
    assert resolved.restrict_to_workspace is False  # what the profile *asked* for

    tools = mgr._build_subagent_tools(
        task_id="t2",
        origin={"channel": "cli", "chat_id": "direct"},
        resolved=resolved,
    )
    read_file = tools.get("read_file")
    (tmp_path / "leak.txt").write_text("nope", encoding="utf-8")

    import asyncio

    with pytest.raises(AgentToolAbort, match="outside allowed directory"):
        asyncio.run(read_file.execute(path=str(tmp_path / "leak.txt")))


def test_profile_exec_cwd_is_agent_dir(tmp_path: Path) -> None:
    """ExecTool on a profiled sub-agent must run inside the per-agent dir."""
    profile = AgentProfile(id="runner", name="Runner")
    mgr = _mgr(tmp_path)
    resolved = _build_resolved(tmp_path, profile)
    tools = mgr._build_subagent_tools(
        task_id="t3",
        origin={"channel": "cli", "chat_id": "direct"},
        resolved=resolved,
    )
    exec_tool = tools.get("exec")
    expected_root = (tmp_path / "agents" / "runner").resolve()
    assert Path(exec_tool.working_dir).resolve() == expected_root
    assert exec_tool.restrict_to_workspace is True


def test_no_profile_keeps_legacy_workspace_behaviour(tmp_path: Path) -> None:
    """Inherited (no profile) sub-agents keep the historical workspace scope."""
    mgr = _mgr(tmp_path)
    tools = mgr._build_subagent_tools(
        task_id="t4",
        origin={"channel": "cli", "chat_id": "direct"},
        resolved=None,
    )
    read_file = tools.get("read_file")
    # Without restrict_to_workspace the legacy path leaves allowed_dir unset.
    assert read_file._allowed_dir is None
    assert read_file._workspace == tmp_path
