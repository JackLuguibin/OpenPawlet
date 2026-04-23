"""Tests for console read of nanobot-format observability JSONL."""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from console.server.observability_jsonl import read_recent_observability_dicts


def test_read_newest_first_and_limit(tmp_path: Path) -> None:
    day = time.strftime("%Y-%m-%d", time.localtime())
    f = tmp_path / "observability" / f"events_{day}.jsonl"
    f.parent.mkdir(parents=True)
    rows = [
        {"ts": 1.0, "event": "a", "trace_id": "t1", "session_key": None, "payload": {}},
        {"ts": 2.0, "event": "b", "trace_id": "t1", "session_key": None, "payload": {}},
        {"ts": 3.0, "event": "c", "trace_id": "t1", "session_key": None, "payload": {}},
    ]
    f.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")

    out, _label, err = read_recent_observability_dicts(tmp_path, limit=2, trace_id=None)
    assert err is None
    assert [e["event"] for e in out] == ["c", "b"]


def test_trace_id_filter(tmp_path: Path) -> None:
    day = time.strftime("%Y-%m-%d", time.localtime())
    f = tmp_path / "observability" / f"events_{day}.jsonl"
    f.parent.mkdir(parents=True)
    rows = [
        {"ts": 1.0, "event": "llm", "trace_id": "a", "session_key": None, "payload": {}},
        {"ts": 2.0, "event": "llm", "trace_id": "b", "session_key": None, "payload": {}},
    ]
    f.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")

    out, _l, err = read_recent_observability_dicts(tmp_path, limit=10, trace_id="b")
    assert err is None
    assert len(out) == 1
    assert out[0]["trace_id"] == "b"


def test_missing_dir_error(tmp_path: Path) -> None:
    out, _l, err = read_recent_observability_dicts(tmp_path, limit=10)
    assert out == []
    assert err is not None


def test_read_from_session_subdir(tmp_path: Path) -> None:
    day = time.strftime("%Y-%m-%d", time.localtime())
    f = tmp_path / "observability" / "sessions" / "sk_a" / f"events_{day}.jsonl"
    f.parent.mkdir(parents=True)
    row = {
        "ts": 1.0,
        "event": "llm",
        "trace_id": "x",
        "session_key": "a:b",
        "payload": {},
    }
    f.write_text(json.dumps(row) + "\n", encoding="utf-8")
    out, _l, err = read_recent_observability_dicts(tmp_path, limit=10, trace_id=None)
    assert err is None
    assert len(out) == 1
    assert out[0]["event"] == "llm"
