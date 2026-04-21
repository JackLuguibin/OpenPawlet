"""Tests for console transcript JSONL parsing (session_store)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from console.server import session_store as ss


def test_parse_transcript_skips_eviction_and_keeps_order(tmp_path: Path) -> None:
    p = tmp_path / "t.jsonl"
    p.write_text(
        "\n".join(
            [
                json.dumps({"role": "user", "content": "a", "timestamp": "t0"}),
                json.dumps(
                    {
                        "_event": "retain_suffix_evict",
                        "messages": [{"role": "user", "content": "gone"}],
                        "timestamp": "t1",
                    }
                ),
                json.dumps({"role": "assistant", "content": "b", "timestamp": "t2"}),
            ]
        ),
        encoding="utf-8",
    )
    out = ss.parse_transcript_jsonl(p)
    assert len(out) == 2
    assert out[0]["content"] == "a"
    assert out[1]["content"] == "b"


def test_load_transcript_messages_none_when_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(ss, "workspace_root", lambda _bid: tmp_path)
    assert ss.load_transcript_messages(None, "websocket:x") is None


def test_load_transcript_messages_reads_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from nanobot.utils.helpers import safe_filename

    monkeypatch.setattr(ss, "workspace_root", lambda _bid: tmp_path)
    key = "websocket:ab-cd"
    stem = safe_filename(key.replace(":", "_"))
    d = tmp_path / "transcripts"
    d.mkdir(parents=True)
    f = d / f"{stem}.jsonl"
    f.write_text(
        json.dumps({"role": "user", "content": "hi", "timestamp": "t"}) + "\n",
        encoding="utf-8",
    )
    got = ss.load_transcript_messages(None, key)
    assert got is not None
    assert len(got) == 1
    assert got[0]["content"] == "hi"
