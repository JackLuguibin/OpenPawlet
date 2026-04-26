"""Dispatch fallback for newly created team room session keys."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from nanobot.agent.loop import AgentLoop
from nanobot.bus.events import InboundMessage
from nanobot.bus.queue import MessageBus


def _make_loop(tmp_path: Path, agent_id: str | None = None) -> AgentLoop:
    bus = MessageBus()
    provider = MagicMock()
    provider.get_default_model.return_value = "test-model"

    with (
        patch("nanobot.agent.loop.SessionManager"),
        patch("nanobot.agent.loop.SubagentManager") as mock_sub_mgr,
        patch("nanobot.agent.loop.Dream"),
    ):
        mock_sub_mgr.return_value.cancel_by_session = AsyncMock(return_value=0)
        return AgentLoop(
            bus=bus,
            provider=provider,
            workspace=tmp_path,
            agent_id=agent_id,
        )


def test_dispatch_falls_back_to_member_loop_by_agent_id(tmp_path: Path) -> None:
    gateway = _make_loop(tmp_path, agent_id="main:gateway")
    member = _make_loop(tmp_path, agent_id="agent-114bb6052148")
    # Existing map can be stale (old room key); new room key should still resolve.
    gateway.team_session_dispatch = {
        "console:team_tm-1_room_room-old_agent_agent-114bb6052148": member,
    }
    new_room_key = "console:team_tm-1_room_room-new_agent_agent-114bb6052148"
    msg = InboundMessage(
        channel="console",
        chat_id="team",
        sender_id="user",
        content="hello",
        session_key_override=new_room_key,
    )

    target, effective_key = gateway._dispatch_target_for_message(msg)
    assert target is member
    assert effective_key == new_room_key
