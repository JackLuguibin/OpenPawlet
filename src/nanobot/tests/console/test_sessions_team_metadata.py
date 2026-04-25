from __future__ import annotations

import asyncio

from console.server.routers.v1.sessions import _row_to_session_info
from console.server.routers.v1 import sessions as sessions_router


def test_row_to_session_info_extracts_team_metadata() -> None:
    row = {
        "key": "console:team_tm1_room_room1_agent_agent1",
        "message_count": 2,
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T01:00:00+00:00",
    }
    info = _row_to_session_info(row)
    assert info.team_id == "tm1"
    assert info.room_id == "room1"
    assert info.agent_id == "agent1"


def test_row_to_session_info_extracts_team_metadata_ephemeral_suffix() -> None:
    row = {
        "key": "console:team_tm1_room_room1_agent_agent1_run_abc123",
        "message_count": 1,
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T01:00:00+00:00",
    }
    info = _row_to_session_info(row)
    assert info.team_id == "tm1"
    assert info.room_id == "room1"
    assert info.agent_id == "agent1"


def test_row_to_session_info_non_team_session() -> None:
    row = {
        "key": "cli:direct",
        "message_count": 1,
        "created_at": None,
        "updated_at": None,
    }
    info = _row_to_session_info(row)
    assert info.team_id is None
    assert info.room_id is None
    assert info.agent_id is None


def test_delete_team_session_rotates_team_room(monkeypatch) -> None:
    saved_payload: dict | None = None
    saved_gateway: tuple[str | None, str, str] | None = None

    def _fake_load_session(_bot_id: str | None, _session_key: str):
        return object()

    def _fake_delete_files(_bot_id: str | None, _session_key: str) -> bool:
        return True

    def _fake_load_json(_path, _default):
        return {
            "teams": [{"id": "tm1", "member_agent_ids": ["agent1"]}],
            "rooms": [{"id": "room1", "team_id": "tm1", "created_at": "old"}],
        }

    def _fake_save_json(_path, data):
        nonlocal saved_payload
        saved_payload = data

    def _fake_save_gateway(bot_id: str | None, team_id: str, room_id: str) -> None:
        nonlocal saved_gateway
        saved_gateway = (bot_id, team_id, room_id)

    monkeypatch.setattr(sessions_router, "load_session", _fake_load_session)
    monkeypatch.setattr(sessions_router, "delete_session_files", _fake_delete_files)
    monkeypatch.setattr(sessions_router, "load_json_file", _fake_load_json)
    monkeypatch.setattr(sessions_router, "save_json_file", _fake_save_json)
    monkeypatch.setattr(sessions_router, "save_active_team_gateway", _fake_save_gateway)
    monkeypatch.setattr(sessions_router, "new_id", lambda _prefix: "room-new")
    monkeypatch.setattr(sessions_router, "iso_now", lambda: "2026-01-01T00:00:00+00:00")

    asyncio.run(
        sessions_router.delete_session(
            "console:team_tm1_room_room1_agent_agent1",
            bot_id="bot-1",
        )
    )
    assert saved_payload is not None
    assert isinstance(saved_payload.get("rooms"), list)
    assert any(
        isinstance(room, dict)
        and room.get("id") == "room-new"
        and room.get("team_id") == "tm1"
        for room in saved_payload["rooms"]
    )
    assert saved_gateway == ("bot-1", "tm1", "room-new")


def test_delete_regular_session_does_not_rotate_team_room(monkeypatch) -> None:
    called = {"load_json": False, "save_json": False, "save_gateway": False}

    def _fake_load_session(_bot_id: str | None, _session_key: str):
        return object()

    def _fake_delete_files(_bot_id: str | None, _session_key: str) -> bool:
        return True

    def _mark_load_json(_path, _default):
        called["load_json"] = True
        return {}

    def _mark_save_json(_path, _data):
        called["save_json"] = True

    def _mark_save_gateway(_bot_id: str | None, _team_id: str, _room_id: str) -> None:
        called["save_gateway"] = True

    monkeypatch.setattr(sessions_router, "load_session", _fake_load_session)
    monkeypatch.setattr(sessions_router, "delete_session_files", _fake_delete_files)
    monkeypatch.setattr(sessions_router, "load_json_file", _mark_load_json)
    monkeypatch.setattr(sessions_router, "save_json_file", _mark_save_json)
    monkeypatch.setattr(sessions_router, "save_active_team_gateway", _mark_save_gateway)

    asyncio.run(sessions_router.delete_session("cli:normal", bot_id="bot-1"))
    assert called == {"load_json": False, "save_json": False, "save_gateway": False}
