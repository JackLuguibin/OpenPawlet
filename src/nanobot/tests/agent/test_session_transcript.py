"""Tests for append-only session transcripts."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from nanobot.agent.hook import AgentHookContext
from nanobot.agent.loop import AgentLoop, _LoopHook
from nanobot.bus.queue import MessageBus
from nanobot.providers.base import LLMResponse
from nanobot.session.transcript import SessionTranscriptWriter
from nanobot.utils.helpers import safe_filename


def _provider() -> MagicMock:
    p = MagicMock()
    p.get_default_model.return_value = "test-model"
    p.estimate_prompt_tokens.return_value = (10_000, "test")
    p.chat_with_retry = AsyncMock(return_value=LLMResponse(content="ok", tool_calls=[]))
    p.generation.max_tokens = 4096
    return p


def _transcript_path(workspace: Path, session_key: str) -> Path:
    safe_key = safe_filename(session_key.replace(":", "_"))
    return workspace / "transcripts" / f"{safe_key}.jsonl"


def test_save_turn_full_tool_in_transcript_session_truncated(tmp_path: Path) -> None:
    long_tool = "x" * 100
    loop = AgentLoop(
        bus=MessageBus(),
        provider=_provider(),
        workspace=tmp_path,
        model="test-model",
        max_tool_result_chars=20,
        persist_session_transcript=True,
        transcript_include_full_tool_results=True,
    )
    loop.tools.get_definitions = MagicMock(return_value=[])
    session = loop.sessions.get_or_create("cli:test")
    messages = [
        {"role": "tool", "tool_call_id": "1", "name": "t", "content": long_tool},
    ]
    loop._save_turn(session, messages, skip=0)
    assert len(session.messages) == 1
    assert "(truncated)" in session.messages[0]["content"]
    assert len(session.messages[0]["content"]) < len(long_tool)

    tpath = _transcript_path(tmp_path, "cli:test")
    assert tpath.exists()
    rec = json.loads(tpath.read_text(encoding="utf-8").strip().split("\n")[0])
    assert rec["role"] == "tool"
    assert rec["content"] == long_tool


def test_transcript_truncates_tool_when_not_full(tmp_path: Path) -> None:
    long_tool = "y" * 100
    loop = AgentLoop(
        bus=MessageBus(),
        provider=_provider(),
        workspace=tmp_path,
        model="test-model",
        max_tool_result_chars=20,
        persist_session_transcript=True,
        transcript_include_full_tool_results=False,
    )
    loop.tools.get_definitions = MagicMock(return_value=[])
    session = loop.sessions.get_or_create("cli:t2")
    loop._save_turn(
        session,
        [{"role": "tool", "tool_call_id": "1", "name": "t", "content": long_tool}],
        skip=0,
    )
    persisted = session.messages[0]["content"]
    assert "(truncated)" in persisted
    tpath = _transcript_path(tmp_path, "cli:t2")
    rec = json.loads(tpath.read_text(encoding="utf-8").strip().split("\n")[0])
    assert rec["content"] == persisted


@pytest.mark.asyncio
async def test_auto_compact_evict_recorded_in_transcript(tmp_path: Path) -> None:
    loop = AgentLoop(
        bus=MessageBus(),
        provider=_provider(),
        workspace=tmp_path,
        model="test-model",
        context_window_tokens=128_000,
        session_ttl_minutes=15,
        persist_session_transcript=True,
    )
    loop.tools.get_definitions = MagicMock(return_value=[])
    session = loop.sessions.get_or_create("cli:test")
    for i in range(20):
        session.add_message("user", f"user {i}")
        session.add_message("assistant", f"assistant {i}")
    loop.sessions.save(session)

    await loop.auto_compact._archive("cli:test")

    tpath = _transcript_path(tmp_path, "cli:test")
    assert tpath.exists()
    lines = [ln for ln in tpath.read_text(encoding="utf-8").split("\n") if ln.strip()]
    parsed = [json.loads(ln) for ln in lines]
    evict_lines = [p for p in parsed if p.get("_event") == "auto_compact_evict"]
    assert len(evict_lines) == 1
    assert len(evict_lines[0]["messages"]) > 0
    assert "metadata" in evict_lines[0]


def test_retain_suffix_evict_recorded(tmp_path: Path) -> None:
    w = SessionTranscriptWriter(
        tmp_path,
        enabled=True,
        include_full_tool_results=False,
        max_tool_result_chars=16_000,
    )
    from nanobot.session.manager import Session

    session = Session(key="heartbeat:test")
    for i in range(10):
        session.messages.append({"role": "user", "content": f"msg{i}"})

    session.retain_recent_legal_suffix(4, transcript=w)

    tpath = _transcript_path(tmp_path, "heartbeat:test")
    assert tpath.exists()
    rec = json.loads(tpath.read_text(encoding="utf-8").strip().split("\n")[0])
    assert rec["_event"] == "retain_suffix_evict"
    assert len(rec["messages"]) == 6


def test_retain_clear_recorded(tmp_path: Path) -> None:
    w = SessionTranscriptWriter(
        tmp_path,
        enabled=True,
        include_full_tool_results=False,
        max_tool_result_chars=16_000,
    )
    from nanobot.session.manager import Session

    session = Session(key="hb:clear")
    for i in range(3):
        session.messages.append({"role": "user", "content": f"x{i}"})
    session.retain_recent_legal_suffix(0, transcript=w)
    assert session.messages == []
    tpath = _transcript_path(tmp_path, "hb:clear")
    rec = json.loads(tpath.read_text(encoding="utf-8").strip().split("\n")[0])
    assert rec["_event"] == "retain_suffix_clear"
    assert len(rec["messages"]) == 3


def _read_transcript_lines(workspace: Path, key: str) -> list[dict]:
    tpath = _transcript_path(workspace, key)
    if not tpath.exists():
        return []
    out: list[dict] = []
    for line in tpath.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        out.append(json.loads(line))
    return out


def _make_loop_with_transcript(tmp_path: Path) -> AgentLoop:
    loop = AgentLoop(
        bus=MessageBus(),
        provider=_provider(),
        workspace=tmp_path,
        model="test-model",
        persist_session_transcript=True,
        transcript_include_full_tool_results=True,
    )
    loop.tools.get_definitions = MagicMock(return_value=[])
    return loop


@pytest.mark.asyncio
async def test_before_execute_tools_flushes_assistant_to_transcript(tmp_path: Path) -> None:
    """Assistant-with-tool_calls must hit the transcript before tool execution."""
    loop = _make_loop_with_transcript(tmp_path)
    key = "cli:inflight"
    hook = _LoopHook(loop, transcript_session_key=key)

    assistant_msg = {
        "role": "assistant",
        "content": "thinking...",
        "tool_calls": [
            {
                "id": "call_1",
                "type": "function",
                "function": {"name": "read_file", "arguments": "{}"},
            }
        ],
    }
    messages = [
        {"role": "user", "content": "hello"},
        assistant_msg,
    ]
    ctx = AgentHookContext(iteration=0, messages=messages)
    ctx.tool_calls = []

    await hook.before_execute_tools(ctx)

    recs = _read_transcript_lines(tmp_path, key)
    assert len(recs) == 1
    assert recs[0]["role"] == "assistant"
    assert recs[0]["tool_calls"][0]["id"] == "call_1"
    # In-memory marker propagates so _save_turn can dedupe later.
    assert assistant_msg.get("_transcript_written") is True


@pytest.mark.asyncio
async def test_after_iteration_flushes_tool_results_to_transcript(tmp_path: Path) -> None:
    """Tool-result messages are appended as soon as the iteration completes."""
    loop = _make_loop_with_transcript(tmp_path)
    key = "cli:inflight2"
    hook = _LoopHook(loop, transcript_session_key=key)

    tool_msg = {
        "role": "tool",
        "tool_call_id": "call_1",
        "name": "read_file",
        "content": "file contents",
    }
    messages = [
        {"role": "user", "content": "hi"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "read_file", "arguments": "{}"},
                }
            ],
            "_transcript_written": True,
        },
        tool_msg,
    ]

    class _FakeToolCall:
        id = "call_1"
        name = "read_file"

    ctx = AgentHookContext(iteration=0, messages=messages)
    ctx.tool_calls = [_FakeToolCall()]
    ctx.tool_results = ["file contents"]

    await hook.after_iteration(ctx)

    recs = _read_transcript_lines(tmp_path, key)
    assert len(recs) == 1
    assert recs[0]["role"] == "tool"
    assert recs[0]["tool_call_id"] == "call_1"
    assert tool_msg.get("_transcript_written") is True


def test_save_turn_skips_transcript_for_inflight_written(tmp_path: Path) -> None:
    """Messages already appended inflight must not be written to transcript again."""
    loop = _make_loop_with_transcript(tmp_path)
    key = "cli:save-dedup"
    session = loop.sessions.get_or_create(key)

    # Pre-populate transcript to simulate inflight writes.
    loop._session_transcript.append_raw_turn_message(
        key,
        {
            "role": "assistant",
            "content": "plan",
            "tool_calls": [
                {
                    "id": "call_x",
                    "type": "function",
                    "function": {"name": "read_file", "arguments": "{}"},
                }
            ],
        },
    )
    loop._session_transcript.append_raw_turn_message(
        key,
        {
            "role": "tool",
            "tool_call_id": "call_x",
            "name": "read_file",
            "content": "data",
        },
    )

    messages = [
        {
            "role": "assistant",
            "content": "plan",
            "tool_calls": [
                {
                    "id": "call_x",
                    "type": "function",
                    "function": {"name": "read_file", "arguments": "{}"},
                }
            ],
            "_transcript_written": True,
        },
        {
            "role": "tool",
            "tool_call_id": "call_x",
            "name": "read_file",
            "content": "data",
            "_transcript_written": True,
        },
        # New assistant reply (no inflight flag) must be appended.
        {"role": "assistant", "content": "final"},
    ]
    loop._save_turn(session, messages, skip=0)

    recs = _read_transcript_lines(tmp_path, key)
    # 2 pre-written + 1 final assistant = 3, never duplicated.
    assert len(recs) == 3
    assert [r["role"] for r in recs] == ["assistant", "tool", "assistant"]
    # Internal marker must not leak into session history.
    for m in session.messages:
        assert "_transcript_written" not in m


def test_restore_runtime_checkpoint_strips_internal_marker(tmp_path: Path) -> None:
    """Resuming from a checkpoint must not carry _transcript_written into session history."""
    loop = _make_loop_with_transcript(tmp_path)
    from nanobot.session.manager import Session

    session = Session(
        key="cli:ckpt",
        metadata={
            AgentLoop._RUNTIME_CHECKPOINT_KEY: {
                "assistant_message": {
                    "role": "assistant",
                    "content": "working",
                    "tool_calls": [
                        {
                            "id": "call_a",
                            "type": "function",
                            "function": {"name": "read_file", "arguments": "{}"},
                        }
                    ],
                    "_transcript_written": True,
                },
                "completed_tool_results": [
                    {
                        "role": "tool",
                        "tool_call_id": "call_a",
                        "name": "read_file",
                        "content": "ok",
                        "_transcript_written": True,
                    }
                ],
                "pending_tool_calls": [],
            }
        },
    )

    assert loop._restore_runtime_checkpoint(session) is True
    for m in session.messages:
        assert "_transcript_written" not in m
