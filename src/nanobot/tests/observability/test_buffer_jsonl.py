"""Tests for JSONL persistence of observability events (always on)."""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from nanobot.utils.helpers import ensure_dir


def _today_events_path(base: Path) -> Path:
    day = time.strftime("%Y-%m-%d", time.localtime())
    return base / "observability" / f"events_{day}.jsonl"


def test_jsonl_always_appends_with_buffer_off(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import nanobot.observability.buffer as buf

    monkeypatch.setattr(buf, "get_data_dir", lambda: ensure_dir(tmp_path))
    monkeypatch.setenv("NANOBOT_OBS_BUFFER", "0")

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


def test_buffer_on_also_appends_jsonl(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import nanobot.observability.buffer as buf

    monkeypatch.setattr(buf, "get_data_dir", lambda: ensure_dir(tmp_path))
    monkeypatch.setenv("NANOBOT_OBS_BUFFER", "1")

    buf.record_event("tool", trace_id="t", session_key="s", payload={"name": "n"})
    out = _today_events_path(tmp_path)
    assert out.is_file()
    row = json.loads(out.read_text(encoding="utf-8").strip().splitlines()[-1])
    assert row["event"] == "tool"
