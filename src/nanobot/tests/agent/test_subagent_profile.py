"""Sub-agent profile integration: spawn(profile=...) and tool whitelist."""

from __future__ import annotations

import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from nanobot.agent.profile_resolver import ProfileStore
from nanobot.agent.subagent import SubagentManager, SubagentStatus
from nanobot.bus.queue import MessageBus
from nanobot.config.profile import AgentDefaultsOverride, AgentProfile, ToolsConfigOverride
from nanobot.config.profile import ExecToolOverride
from nanobot.config.schema import AgentDefaults, ExecToolConfig, ToolsConfig

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
async def test_inline_profile_skips_disk(tmp_path: Path) -> None:
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
    # Inline profile must not write to disk.
    assert not (tmp_path / "agents" / "ad-hoc").exists()
