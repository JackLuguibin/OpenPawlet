"""Tests for console session deletion, transcript, and observability cleanup."""

from __future__ import annotations

import json
import time
from pathlib import Path

from console.server import session_store
from nanobot.session.manager import SessionManager
from nanobot.utils.helpers import safe_filename


def test_delete_session_removes_matching_transcript(monkeypatch, tmp_path: Path) -> None:
    def fake_mgr(_bot_id: str | None) -> SessionManager:
        return SessionManager(tmp_path, timezone=None)

    monkeypatch.setattr(session_store, "_session_manager", fake_mgr)
    monkeypatch.setattr(session_store, "workspace_root", lambda _bot_id: tmp_path)

    key = "telegram:123"
    mgr = SessionManager(tmp_path, timezone=None)
    session_path = mgr._get_session_path(key)
    session_path.write_text(
        '{"_type":"metadata","key":"' + key + '","created_at":"","updated_at":""}\n',
        encoding="utf-8",
    )
    tr_dir = tmp_path / "transcripts"
    tr_dir.mkdir(parents=True)
    tr_file = tr_dir / f"{mgr.safe_key(key)}.jsonl"
    tr_file.write_text("{}\n", encoding="utf-8")

    assert session_store.delete_session_files(None, key) is True
    assert not session_path.is_file()
    assert not tr_file.is_file()


def test_delete_session_without_transcript_still_ok(monkeypatch, tmp_path: Path) -> None:
    def fake_mgr(_bot_id: str | None) -> SessionManager:
        return SessionManager(tmp_path, timezone=None)

    monkeypatch.setattr(session_store, "_session_manager", fake_mgr)
    monkeypatch.setattr(session_store, "workspace_root", lambda _bot_id: tmp_path)

    key = "cli:only-session"
    mgr = SessionManager(tmp_path, timezone=None)
    session_path = mgr._get_session_path(key)
    session_path.write_text(
        '{"_type":"metadata","key":"' + key + '","created_at":"","updated_at":""}\n',
        encoding="utf-8",
    )

    assert session_store.delete_session_files(None, key) is True
    assert not session_path.is_file()


def test_delete_missing_session_leaves_transcript(monkeypatch, tmp_path: Path) -> None:
    def fake_mgr(_bot_id: str | None) -> SessionManager:
        return SessionManager(tmp_path, timezone=None)

    monkeypatch.setattr(session_store, "_session_manager", fake_mgr)
    monkeypatch.setattr(session_store, "workspace_root", lambda _bot_id: tmp_path)

    key = "orphan:tr"
    mgr = SessionManager(tmp_path, timezone=None)
    tr_dir = tmp_path / "transcripts"
    tr_dir.mkdir(parents=True)
    tr_file = tr_dir / f"{mgr.safe_key(key)}.jsonl"
    tr_file.write_text("{}\n", encoding="utf-8")

    assert session_store.delete_session_files(None, key) is False
    assert tr_file.is_file()


def test_delete_session_removes_observability_session_dir(
    monkeypatch, tmp_path: Path
) -> None:
    def fake_mgr(_bot_id: str | None) -> SessionManager:
        return SessionManager(tmp_path, timezone=None)

    monkeypatch.setattr(session_store, "_session_manager", fake_mgr)
    monkeypatch.setattr(session_store, "workspace_root", lambda _bot_id: tmp_path)

    key = "chan:1"
    mgr = SessionManager(tmp_path, timezone=None)
    session_path = mgr._get_session_path(key)
    session_path.write_text(
        '{"_type":"metadata","key":"' + key + '","created_at":"","updated_at":""}\n',
        encoding="utf-8",
    )
    day = time.strftime("%Y-%m-%d", time.localtime())
    safe = safe_filename(key.replace(":", "_"))
    obs_f = (
        tmp_path
        / "observability"
        / "sessions"
        / safe
        / f"events_{day}.jsonl"
    )
    obs_f.parent.mkdir(parents=True)
    obs_f.write_text(json.dumps({"ts": 0.0, "event": "x", "trace_id": None, "session_key": key, "payload": {}}) + "\n", encoding="utf-8")

    assert session_store.delete_session_files(None, key) is True
    assert not session_path.is_file()
    assert not (tmp_path / "observability" / "sessions" / safe).exists()
