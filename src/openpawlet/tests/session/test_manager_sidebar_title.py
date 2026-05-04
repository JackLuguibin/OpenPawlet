"""Session sidebar title persistence (.meta.json)."""

from __future__ import annotations

import json

from openpawlet.session.manager import SessionManager


def test_set_sidebar_title_writes_meta(tmp_path):
    mgr = SessionManager(tmp_path)
    key = "cron:job1-deadbeef01"
    mgr.set_sidebar_title(key, "  Nightly report  ")
    meta_path = tmp_path / "sessions" / ".meta.json"
    data = json.loads(meta_path.read_text(encoding="utf-8"))
    assert data[key]["title"] == "Nightly report"


def test_set_sidebar_title_clear_removes_row(tmp_path):
    mgr = SessionManager(tmp_path)
    key = "cron:x-y"
    mgr.set_sidebar_title(key, "A")
    mgr.set_sidebar_title(key, None)
    meta_path = tmp_path / "sessions" / ".meta.json"
    data = json.loads(meta_path.read_text(encoding="utf-8"))
    assert key not in data
