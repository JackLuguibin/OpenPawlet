"""Tests for optional JSONL persistence of observability events."""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from nanobot.utils.helpers import ensure_dir


def _today_events_path(base: Path) -> Path:
    day = time.strftime("%Y-%m-%d", time.localtime())
    return base / "observability" / f"events_{day}.jsonl"


def test_jsonl_data_dir_mode_appends_with_buffer_off(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """NANOBOT_OBS_JSONL=1 writes under get_data_dir()/observability/events_YYYY-MM-DD.jsonl."""
    import nanobot.observability.buffer as buf

    monkeypatch.setattr(buf, "get_data_dir", lambda: ensure_dir(tmp_path))
    monkeypatch.setenv("NANOBOT_OBS_BUFFER", "0")
    monkeypatch.setenv("NANOBOT_OBS_JSONL", "1")

    assert buf.is_jsonl_enabled() is True
    buf.record_event(
        "llm",
        trace_id="tr-1",
        session_key="sk",
        payload={"k": 1},
    )
    out = _today_events_path(tmp_path)
    assert out.is_file()
    row = json.loads(out.read_text(encoding="utf-8").strip().splitlines()[-1])
    assert row["event"] == "llm"
    assert row["trace_id"] == "tr-1"
    assert row["session_key"] == "sk"
    assert row["payload"] == {"k": 1}
    assert isinstance(row["ts"], (int, float))


def test_jsonl_disabled_does_not_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import nanobot.observability.buffer as buf

    monkeypatch.setattr(buf, "get_data_dir", lambda: ensure_dir(tmp_path))
    monkeypatch.setenv("NANOBOT_OBS_BUFFER", "0")
    monkeypatch.setenv("NANOBOT_OBS_JSONL", "0")

    assert buf.is_jsonl_enabled() is False
    buf.record_event("llm", trace_id="t", session_key="s", payload={})
    assert not (tmp_path / "observability").exists()


def test_jsonl_explicit_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import nanobot.observability.buffer as buf

    target = tmp_path / "my_obs.jsonl"
    monkeypatch.setenv("NANOBOT_OBS_BUFFER", "0")
    monkeypatch.setenv("NANOBOT_OBS_JSONL", str(target))

    buf.record_event("tool", trace_id=None, session_key="x", payload={"name": "n"})
    assert target.is_file()
    row = json.loads(target.read_text(encoding="utf-8").strip())
    assert row["event"] == "tool"
    assert row["session_key"] == "x"
    assert row["payload"] == {"name": "n"}
