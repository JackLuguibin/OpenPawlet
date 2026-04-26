"""Contract tests: agent IANA timezone is passed explicitly (no process-global TZ)."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from unittest.mock import MagicMock, patch
from zoneinfo import ZoneInfo

import pytest

from nanobot.agent.context import ContextBuilder
from nanobot.agent.loop import AgentLoop
from nanobot.agent.memory import MemoryStore
from nanobot.bus.queue import MessageBus
from nanobot.session.manager import SessionManager
from nanobot.utils.helpers import local_now, timestamp
from nanobot.utils.token_usage_jsonl import TokenUsageJsonlRecorder


def test_local_now_uses_explicit_iana_utc() -> None:
    now = local_now("UTC")
    assert now.tzinfo is not None
    assert now.utcoffset() is not None
    assert now.utcoffset().total_seconds() == 0


def test_local_now_uses_explicit_iana_non_utc() -> None:
    sh = local_now("Asia/Shanghai")
    assert sh.tzinfo == ZoneInfo("Asia/Shanghai")


def test_timestamp_is_parseable_iso_in_configured_zone() -> None:
    tz = "Asia/Tokyo"
    s = timestamp(tz)
    parsed = datetime.fromisoformat(s)
    assert parsed.utcoffset() == ZoneInfo("Asia/Tokyo").utcoffset(parsed)


def test_session_manager_propagates_timezone_to_sessions(tmp_path: Path) -> None:
    mgr = SessionManager(tmp_path, timezone="Asia/Tokyo")
    s = mgr.get_or_create("cli:direct")
    assert s.agent_timezone == "Asia/Tokyo"
    s.add_message("user", "hello")
    ts = s.messages[0]["timestamp"]
    parsed = datetime.fromisoformat(ts)
    tokyo = ZoneInfo("Asia/Tokyo")
    assert parsed.utcoffset() == tokyo.utcoffset(parsed)


def test_session_manager_configure_timezone_updates_binding(tmp_path: Path) -> None:
    mgr = SessionManager(tmp_path, timezone="UTC")
    mgr.configure_timezone("Asia/Shanghai")
    s = mgr.get_or_create("k:1")
    assert s.agent_timezone == "Asia/Shanghai"


def test_agent_loop_aligns_self_context_and_session_manager(tmp_path: Path) -> None:
    provider = MagicMock()
    provider.get_default_model.return_value = "m"
    loop = AgentLoop(
        bus=MessageBus(),
        provider=provider,
        workspace=tmp_path,
        model="m",
        timezone="Europe/Berlin",
    )
    assert loop.timezone == "Europe/Berlin"
    assert loop.context.timezone == "Europe/Berlin"
    assert loop.sessions.agent_timezone == "Europe/Berlin"
    sess = loop.sessions.get_or_create("x:y")
    assert sess.agent_timezone == "Europe/Berlin"


def test_agent_loop_rebinds_prebuilt_session_manager_timezone(tmp_path: Path) -> None:
    mgr = SessionManager(tmp_path, timezone="UTC")
    provider = MagicMock()
    provider.get_default_model.return_value = "m"
    loop = AgentLoop(
        bus=MessageBus(),
        provider=provider,
        workspace=tmp_path,
        model="m",
        session_manager=mgr,
        timezone="Australia/Sydney",
    )
    assert loop.sessions.agent_timezone == "Australia/Sydney"
    assert mgr.get_or_create("a:b").agent_timezone == "Australia/Sydney"


def test_context_builder_memory_store_shares_timezone(tmp_path: Path) -> None:
    ctx = ContextBuilder(tmp_path, timezone="America/Vancouver")
    assert ctx.memory.timezone == "America/Vancouver"


def test_memory_store_append_history_uses_store_timezone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: list[str | None] = []

    def _spy(tz: str | None = None):
        captured.append(tz)
        return datetime(2026, 1, 2, 3, 4, tzinfo=ZoneInfo("UTC"))

    monkeypatch.setattr("nanobot.agent.memory.local_now", _spy)
    store = MemoryStore(tmp_path, timezone="Pacific/Auckland")
    store.append_history("note")
    assert captured and captured[0] == "Pacific/Auckland"


def test_token_usage_jsonl_partitions_by_agent_calendar_day(tmp_path: Path) -> None:
    # 2026-06-15 15:00 UTC == 2026-06-16 00:00 in Asia/Tokyo
    fixed = datetime(2026, 6, 15, 15, 0, 0, tzinfo=ZoneInfo("UTC")).astimezone(
        ZoneInfo("Asia/Tokyo")
    )
    with patch("nanobot.utils.token_usage_jsonl.local_now", return_value=fixed):
        rec = TokenUsageJsonlRecorder(tmp_path, timezone="Asia/Tokyo")
        rec.record(
            {"prompt_tokens": 1},
            model="m",
            finish_reason="stop",
            streaming=False,
        )
    out = tmp_path / "usage" / "token_usage_2026-06-16.jsonl"
    assert out.is_file()
    assert "prompt_tokens" in out.read_text(encoding="utf-8")
