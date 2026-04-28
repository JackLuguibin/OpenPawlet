"""Tests for local runtime log tail I/O (console server)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from console.server.app import create_app
from console.server.routers.v1 import runtime_logs as runtime_logs_mod
from console.server.runtime_log_read import read_tail_text


def test_read_tail_respects_max_lines(tmp_path: Path) -> None:
    p = tmp_path / "a.log"
    p.write_text("\n".join(f"line-{i}" for i in range(10)) + "\n", encoding="utf-8")
    text, truncated = read_tail_text(p, max_lines=3)
    assert "line-7" in text
    assert "line-9" in text
    assert "line-0" not in text
    assert truncated is True


def test_read_tail_no_file(tmp_path: Path) -> None:
    p = tmp_path / "missing.log"
    text, truncated = read_tail_text(p, max_lines=5)
    assert text == ""
    assert truncated is False


def test_runtime_logs_api_uses_temporary_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    c = tmp_path / "console.log"
    c.write_text("two\n", encoding="utf-8")

    def fake(_key: str) -> Path:
        if _key == "console":
            return c
        raise AssertionError

    monkeypatch.setattr(runtime_logs_mod, "default_runtime_log_path", fake)

    client = TestClient(create_app())
    rjson = client.get("/api/v1/runtime-logs?source=all&limit=20").json()
    assert rjson["code"] == 0
    chunks = rjson["data"]["chunks"]
    assert len(chunks) == 1
    by = {c["source"]: c for c in chunks}
    assert "two" in by["console"]["text"]


def test_runtime_logs_clear_api_truncates_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    c = tmp_path / "console.log"
    c.write_text("old-content\n", encoding="utf-8")

    def fake(_key: str) -> Path:
        if _key == "console":
            return c
        raise AssertionError

    monkeypatch.setattr(runtime_logs_mod, "default_runtime_log_path", fake)

    client = TestClient(create_app())
    rjson = client.post("/api/v1/runtime-logs/clear").json()
    assert rjson["code"] == 0
    assert rjson["data"]["status"] == "ok"
    assert c.read_text(encoding="utf-8") == ""


def test_runtime_logs_cursor_pagination_is_snapshot_bound(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    c = tmp_path / "console.log"
    c.write_text("\n".join(f"line-{i}" for i in range(10)) + "\n", encoding="utf-8")

    def fake(_key: str) -> Path:
        if _key == "console":
            return c
        raise AssertionError

    monkeypatch.setattr(runtime_logs_mod, "default_runtime_log_path", fake)

    client = TestClient(create_app())
    first = client.get("/api/v1/runtime-logs?source=all&limit=3").json()
    first_chunk = first["data"]["chunks"][0]
    assert "line-9" in first_chunk["text"]
    assert first_chunk["has_more"] is True
    assert first_chunk["next_cursor"]

    # Append a newer line after first page; older-page request must stay on snapshot.
    c.write_text(c.read_text(encoding="utf-8") + "line-10\n", encoding="utf-8")

    second = client.get(
        f"/api/v1/runtime-logs?source=all&limit=3&cursor={first_chunk['next_cursor']}"
    ).json()
    second_chunk = second["data"]["chunks"][0]
    assert "line-6" in second_chunk["text"]
    assert "line-4" in second_chunk["text"]
    assert "line-10" not in second_chunk["text"]
