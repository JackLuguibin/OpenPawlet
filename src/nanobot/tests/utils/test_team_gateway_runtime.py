"""Tests for workspace team gateway pointer resolution."""

from __future__ import annotations

import json
from pathlib import Path

import pytest


def _write_teams(ws: Path, *, teams: list, rooms: list) -> None:
    d = ws / ".nanobot_console"
    d.mkdir(parents=True, exist_ok=True)
    (d / "teams.json").write_text(
        json.dumps({"teams": teams, "rooms": rooms}, ensure_ascii=False),
        encoding="utf-8",
    )


def _write_pointer(ws: Path, team_id: str, room_id: str) -> None:
    d = ws / ".nanobot_console"
    d.mkdir(parents=True, exist_ok=True)
    (d / "active_team_gateway.json").write_text(
        json.dumps({"team_id": team_id, "room_id": room_id}, ensure_ascii=False),
        encoding="utf-8",
    )


def test_resolve_from_pointer(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("NANOBOT_TEAM_ID", raising=False)
    monkeypatch.delenv("NANOBOT_TEAM_ROOM_ID", raising=False)
    _write_teams(
        tmp_path,
        teams=[{"id": "tm1", "member_agent_ids": ["a1", "a2"], "name": "T"}],
        rooms=[{"id": "room1", "team_id": "tm1"}],
    )
    _write_pointer(tmp_path, "tm1", "room1")
    from nanobot.utils.team_gateway_runtime import resolve_gateway_team_context

    tid, rid, members = resolve_gateway_team_context(tmp_path)
    assert tid == "tm1"
    assert rid == "room1"
    assert members == ["a1", "a2"]


def test_env_overrides_pointer(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write_teams(
        tmp_path,
        teams=[{"id": "tm1", "member_agent_ids": ["a1"], "name": "T"}],
        rooms=[{"id": "room1", "team_id": "tm1"}],
    )
    _write_pointer(tmp_path, "tm1", "room1")
    monkeypatch.setenv("NANOBOT_TEAM_ID", "tmX")
    monkeypatch.setenv("NANOBOT_TEAM_ROOM_ID", "roomX")
    _write_teams(
        tmp_path,
        teams=[{"id": "tmX", "member_agent_ids": ["x1"], "name": "X"}],
        rooms=[{"id": "roomX", "team_id": "tmX"}],
    )
    from nanobot.utils.team_gateway_runtime import resolve_gateway_team_context

    tid, rid, members = resolve_gateway_team_context(tmp_path)
    assert tid == "tmX"
    assert rid == "roomX"
    assert members == ["x1"]


def test_invalid_room_returns_empty(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("NANOBOT_TEAM_ID", raising=False)
    monkeypatch.delenv("NANOBOT_TEAM_ROOM_ID", raising=False)
    _write_teams(
        tmp_path,
        teams=[{"id": "tm1", "member_agent_ids": ["a1"], "name": "T"}],
        rooms=[{"id": "room1", "team_id": "tm1"}],
    )
    _write_pointer(tmp_path, "tm1", "missing-room")
    from nanobot.utils.team_gateway_runtime import resolve_gateway_team_context

    tid, rid, members = resolve_gateway_team_context(tmp_path)
    assert tid is None
    assert rid is None
    assert members == []


def test_load_all_team_member_bindings(tmp_path: Path) -> None:
    _write_teams(
        tmp_path,
        teams=[
            {"id": "tm1", "member_agent_ids": ["a1", "a2"], "name": "T1"},
            {"id": "tm2", "member_agent_ids": ["b1"], "name": "T2"},
        ],
        rooms=[
            {"id": "room1", "team_id": "tm1"},
            {"id": "room2", "team_id": "tm1"},
            {"id": "room3", "team_id": "tm2"},
        ],
    )
    from nanobot.utils.team_gateway_runtime import load_all_team_member_bindings

    bindings = load_all_team_member_bindings(tmp_path)
    assert ("tm1", "room1", "a1", "console:team_tm1_room_room1_agent_a1") in bindings
    assert ("tm1", "room2", "a2", "console:team_tm1_room_room2_agent_a2") in bindings
    assert ("tm2", "room3", "b1", "console:team_tm2_room_room3_agent_b1") in bindings
    assert len(bindings) == 5


def test_resolve_effective_gateway_agent_id_single_file(tmp_path: Path) -> None:
    a = tmp_path / "agents"
    a.mkdir(parents=True, exist_ok=True)
    (a / "sole.json").write_text("{}", encoding="utf-8")
    from nanobot.utils.team_gateway_runtime import resolve_effective_gateway_agent_id

    assert resolve_effective_gateway_agent_id(tmp_path) == "sole"


def test_resolve_effective_gateway_agent_id_multi_prefers_active_team(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("NANOBOT_TEAM_ID", raising=False)
    monkeypatch.delenv("NANOBOT_TEAM_ROOM_ID", raising=False)
    a = tmp_path / "agents"
    a.mkdir(parents=True, exist_ok=True)
    (a / "a1.json").write_text("{}", encoding="utf-8")
    (a / "a2.json").write_text("{}", encoding="utf-8")
    _write_teams(
        tmp_path,
        teams=[{"id": "tm1", "member_agent_ids": ["a1", "a2"], "name": "T"}],
        rooms=[{"id": "room1", "team_id": "tm1"}],
    )
    _write_pointer(tmp_path, "tm1", "room1")
    from nanobot.utils.team_gateway_runtime import resolve_effective_gateway_agent_id

    # Ambiguous: two agent files, both in team
    assert resolve_effective_gateway_agent_id(tmp_path) is None

    (a / "a2.json").unlink()
    assert resolve_effective_gateway_agent_id(tmp_path) == "a1"
