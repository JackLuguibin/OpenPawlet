"""Unit tests for team session keys and merged transcript ordering."""

from __future__ import annotations

from unittest.mock import patch

from console.server.team_transcript import merge_team_transcript, team_member_session_key


def test_team_member_session_key() -> None:
    assert team_member_session_key("tm1", "room1", "ag1") == (
        "console:team_tm1_room_room1_agent_ag1"
    )


def test_team_member_session_key_with_nonce() -> None:
    assert team_member_session_key("tm1", "room1", "ag1", nonce="run1") == (
        "console:team_tm1_room_room1_agent_ag1_run_run1"
    )


def test_merge_team_transcript_sorts_by_timestamp() -> None:
    sk1 = team_member_session_key("t", "r", "a1")
    sk2 = team_member_session_key("t", "r", "a2")

    def fake_load(_bot_id: str | None, session_key: str) -> list[dict]:
        if session_key == sk1:
            return [
                {"role": "assistant", "content": "second", "timestamp": "2026-01-02T00:00:00+00:00"},
                {"role": "user", "content": "first", "timestamp": "2026-01-01T00:00:00+00:00"},
            ]
        if session_key == sk2:
            return [
                {"role": "assistant", "content": "middle", "timestamp": "2026-01-01T12:00:00+00:00"},
            ]
        return []

    with patch("console.server.team_transcript.load_messages_for_key", side_effect=fake_load):
        _keys, rows = merge_team_transcript(
            None,
            team_id="t",
            room_id="r",
            member_agent_ids=["a1", "a2"],
            id_to_name={"a1": "A", "a2": "B"},
        )
    texts = [r["content"] for r in rows]
    assert texts == ["first", "middle", "second"]
