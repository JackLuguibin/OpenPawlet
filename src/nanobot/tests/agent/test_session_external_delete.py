"""Stale in-process session cache when another process deletes the JSONL file."""

from __future__ import annotations

from pathlib import Path

from nanobot.session.manager import SessionManager


def test_get_or_create_drops_cache_after_external_file_delete(tmp_path: Path) -> None:
    mgr = SessionManager(tmp_path)
    key = "console:team_x_room_y_agent_z"
    s1 = mgr.get_or_create(key)
    s1.add_message("user", "keep")
    s1.add_message("assistant", "old")
    mgr.save(s1)

    path = mgr._get_session_path(key)
    assert path.is_file()
    path.unlink()

    s2 = mgr.get_or_create(key)
    assert s2.messages == []


def test_get_or_create_keeps_unsaved_in_memory_session(tmp_path: Path) -> None:
    mgr = SessionManager(tmp_path)
    key = "cli:not-yet-saved"
    s1 = mgr.get_or_create(key)
    s1.add_message("user", "pending")
    assert not mgr._get_session_path(key).is_file()

    s2 = mgr.get_or_create(key)
    assert s1 is s2
    assert len(s2.messages) == 1
    assert s2.messages[0]["content"] == "pending"


def test_save_does_not_resurrect_history_after_external_delete(tmp_path: Path) -> None:
    mgr = SessionManager(tmp_path)
    key = "console:team_x_room_y_agent_z"
    s1 = mgr.get_or_create(key)
    s1.add_message("user", "old-user")
    s1.add_message("assistant", "old-assistant")
    mgr.save(s1)

    path = mgr._get_session_path(key)
    assert path.is_file()
    path.unlink()

    # Simulate long-lived process still holding stale session object and saving again.
    mgr.save(s1)
    s2 = mgr.get_or_create(key)
    assert s2.messages == []
