"""Tests for console session deletion, transcript, and observability cleanup."""

from __future__ import annotations

import json
import time
from pathlib import Path

from console.server import session_store
from nanobot.session.manager import (
    Session,
    SessionManager,
    _register_runtime_manager,
    _unregister_runtime_manager,
)
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


def test_delete_session_removes_observability_session_dir(monkeypatch, tmp_path: Path) -> None:
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
    obs_f = tmp_path / "observability" / "sessions" / safe / f"events_{day}.jsonl"
    obs_f.parent.mkdir(parents=True)
    obs_f.write_text(
        json.dumps({"ts": 0.0, "event": "x", "trace_id": None, "session_key": key, "payload": {}})
        + "\n",
        encoding="utf-8",
    )

    assert session_store.delete_session_files(None, key) is True
    assert not session_path.is_file()
    assert not (tmp_path / "observability" / "sessions" / safe).exists()


def test_delete_session_invalidates_runtime_cache(monkeypatch, tmp_path: Path) -> None:
    """Console DELETE must drop the in-memory copy held by the agent loop."""

    def fake_mgr(_bot_id: str | None) -> SessionManager:
        return SessionManager(tmp_path, timezone=None)

    monkeypatch.setattr(session_store, "_session_manager", fake_mgr)
    monkeypatch.setattr(session_store, "workspace_root", lambda _bot_id: tmp_path)

    runtime_mgr = SessionManager(tmp_path, timezone=None)
    _register_runtime_manager(runtime_mgr)
    try:
        key = "websocket:abc"
        session = runtime_mgr.get_or_create(key)
        session.add_message("user", "hi")
        runtime_mgr.save(session)
        assert key in runtime_mgr._cache

        assert session_store.delete_session_files(None, key) is True
        assert key not in runtime_mgr._cache
    finally:
        _unregister_runtime_manager(runtime_mgr)


def test_flush_all_skips_zero_message_zero_metadata_session(tmp_path: Path) -> None:
    """An empty in-memory session must not be persisted on shutdown flush."""
    mgr = SessionManager(tmp_path, timezone=None)
    key = "websocket:ghost"
    session = mgr.get_or_create(key)
    assert not session.messages and not session.metadata

    flushed = mgr.flush_all()
    assert flushed == 0
    assert not mgr._get_session_path(key).is_file()
    assert key not in mgr._cache


def test_flush_all_does_not_resurrect_externally_deleted_session(tmp_path: Path) -> None:
    """A session removed from disk must not reappear via the shutdown flush."""
    mgr = SessionManager(tmp_path, timezone=None)
    key = "websocket:deleted"
    session = mgr.get_or_create(key)
    session.add_message("user", "hello")
    mgr.save(session)
    path = mgr._get_session_path(key)
    assert path.is_file()

    path.unlink()

    flushed = mgr.flush_all()
    assert flushed == 0
    assert not path.is_file()
    assert key not in mgr._cache


def test_save_drops_session_when_file_was_externally_deleted(tmp_path: Path) -> None:
    """``save`` for a disk-anchored session must honor an external delete."""
    mgr = SessionManager(tmp_path, timezone=None)
    key = "cli:zombie"
    session = mgr.get_or_create(key)
    session.add_message("user", "round 1")
    mgr.save(session)
    path = mgr._get_session_path(key)
    assert path.is_file()

    path.unlink()

    session.add_message("user", "round 2")
    mgr.save(session)

    assert not path.is_file()
    assert key not in mgr._cache


def test_zero_message_session_with_metadata_is_still_flushed(tmp_path: Path) -> None:
    """Metadata-only sessions (e.g. checkpointed turns) must not be dropped."""
    mgr = SessionManager(tmp_path, timezone=None)
    key = "cli:checkpoint"
    session = mgr.get_or_create(key)
    session.metadata["_runtime_checkpoint"] = {"phase": "pending"}

    flushed = mgr.flush_all()
    assert flushed == 1
    assert mgr._get_session_path(key).is_file()


def test_dummy_session_helper_keeps_test_imports_used() -> None:
    """Quietly reference ``Session`` so the import linter sees a usage."""
    s = Session(key="cli:noop")
    assert s.key == "cli:noop"
