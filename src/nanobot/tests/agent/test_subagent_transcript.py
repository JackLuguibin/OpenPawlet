"""Sub-agent transcript persistence + parent session event embedding."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from nanobot.agent.subagent import SubagentManager
from nanobot.bus.queue import MessageBus
from nanobot.config.schema import AgentDefaults, ExecToolConfig, ToolsConfig
from nanobot.session.manager import SessionManager
from nanobot.session.transcript import SessionTranscriptWriter
from nanobot.utils.helpers import safe_filename

_MAX_TOOL_RESULT_CHARS = AgentDefaults().max_tool_result_chars


def _transcript_path(workspace: Path, session_key: str) -> Path:
    safe_key = safe_filename(session_key.replace(":", "_"))
    return workspace / "transcripts" / f"{safe_key}.jsonl"


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def _make_manager(workspace: Path) -> SubagentManager:
    bus = MessageBus()
    provider = MagicMock()
    provider.get_default_model.return_value = "main-model"
    transcript = SessionTranscriptWriter(
        workspace,
        enabled=True,
        include_full_tool_results=True,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
    )
    sessions = SessionManager(workspace)
    return SubagentManager(
        provider=provider,
        workspace=workspace,
        bus=bus,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
        exec_config=ExecToolConfig(),
        base_defaults=AgentDefaults(model="main-model", max_tokens=8000),
        base_tools=ToolsConfig(),
        transcript_writer=transcript,
        session_manager=sessions,
    )


@pytest.mark.asyncio
async def test_subagent_persists_dedicated_transcript(tmp_path: Path) -> None:
    """The sub-agent flushes its own messages to ``subagent:<parent>:<task>``."""
    mgr = _make_manager(tmp_path)
    mgr._announce_result = AsyncMock()

    captured_spec: dict[str, object] = {}

    async def fake_run(spec):
        captured_spec["session_key"] = spec.session_key
        captured_spec["workspace"] = spec.workspace
        # Drive the hook so it mirrors the runner's per-iteration behaviour.
        from nanobot.agent.hook import AgentHookContext

        msgs = list(spec.initial_messages)
        msgs.append({"role": "assistant", "content": "interim", "reply_group_id": "g1"})
        ctx = AgentHookContext(iteration=0, messages=msgs)
        await spec.hook.after_iteration(ctx)
        msgs.append({"role": "assistant", "content": "final answer"})
        return SimpleNamespace(
            stop_reason="completed",
            final_content="final answer",
            error=None,
            tool_events=[],
            messages=msgs,
        )

    mgr.runner.run = AsyncMock(side_effect=fake_run)

    task_id = await mgr.spawn_task(
        task="do work",
        label="work",
        origin_channel="cli",
        origin_chat_id="direct",
        session_key="cli:direct",
    )
    await mgr._running_tasks[task_id]

    sub_key = f"subagent:cli:direct:{task_id}"
    assert captured_spec["session_key"] == sub_key
    assert captured_spec["workspace"] == tmp_path

    # Sub-agent transcript must contain system + user + interim + final lines.
    rows = _read_jsonl(_transcript_path(tmp_path, sub_key))
    roles = [r.get("role") for r in rows]
    assert roles[0] == "system"
    assert roles[1] == "user"
    assert "assistant" in roles[2:]
    assert any(r.get("content") == "final answer" for r in rows)


@pytest.mark.asyncio
async def test_parent_session_receives_subagent_events(tmp_path: Path) -> None:
    """Parent transcript gains structured ``subagent_start`` + ``subagent_done`` rows."""
    mgr = _make_manager(tmp_path)
    mgr._announce_result = AsyncMock()

    async def fake_run(spec):
        return SimpleNamespace(
            stop_reason="completed",
            final_content="all done",
            error=None,
            tool_events=[],
            messages=list(spec.initial_messages),
        )

    mgr.runner.run = AsyncMock(side_effect=fake_run)

    parent_key = "cli:direct"
    task_id = await mgr.spawn_task(
        task="ship feature",
        label="feature",
        origin_channel="cli",
        origin_chat_id="direct",
        session_key=parent_key,
    )
    await mgr._running_tasks[task_id]

    # Build the announcement inline (the test stubs out _announce_result so it
    # never fires; trigger the parent-event side of the call manually).
    sub_key = f"subagent:{parent_key}:{task_id}"
    mgr._emit_parent_event(
        parent_key,
        "subagent_done",
        content="manual",
        metadata={"subagent_session_key": sub_key, "task_id": task_id},
    )

    parent_rows = _read_jsonl(_transcript_path(tmp_path, parent_key))
    events = [
        r.get("metadata", {}).get("event") for r in parent_rows if r.get("source") == "subagent_event"
    ]
    assert "subagent_start" in events
    # ``subagent_done`` came from the manual emit above (real path uses
    # _announce_result which is stubbed in this unit-style test).
    assert "subagent_done" in events


@pytest.mark.asyncio
async def test_subagent_session_placeholder_created(tmp_path: Path) -> None:
    """Sub-agent run materialises a sessions/<key>.jsonl so the list shows it."""
    mgr = _make_manager(tmp_path)
    mgr._announce_result = AsyncMock()

    async def fake_run(spec):
        return SimpleNamespace(
            stop_reason="completed",
            final_content="ok",
            error=None,
            tool_events=[],
            messages=list(spec.initial_messages),
        )

    mgr.runner.run = AsyncMock(side_effect=fake_run)

    task_id = await mgr.spawn_task(
        task="task",
        label="t",
        origin_channel="cli",
        origin_chat_id="direct",
        session_key="cli:direct",
    )
    await mgr._running_tasks[task_id]

    sub_key = f"subagent:cli:direct:{task_id}"
    safe_key = safe_filename(sub_key.replace(":", "_"))
    placeholder = tmp_path / "sessions" / f"{safe_key}.jsonl"
    assert placeholder.is_file(), "session placeholder should exist for the console list"
