from __future__ import annotations

import json
from pathlib import Path

from console.server.routers.v1.agents import _attach_team_memberships


def test_attach_team_memberships(tmp_path: Path) -> None:
    ws = tmp_path / ".openpawlet_console"
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "teams.json").write_text(
        json.dumps(
            {
                "teams": [
                    {"id": "tm1", "member_agent_ids": ["a1", "a2"]},
                    {"id": "tm2", "member_agent_ids": ["a2"]},
                ],
                "rooms": [],
            }
        ),
        encoding="utf-8",
    )
    agents = [
        {
            "id": "a1",
            "name": "A1",
            "description": None,
            "model": None,
            "temperature": None,
            "system_prompt": None,
            "skills": [],
            "topics": [],
            "collaborators": [],
            "enabled": True,
            "created_at": "x",
        },
        {
            "id": "a2",
            "name": "A2",
            "description": None,
            "model": None,
            "temperature": None,
            "system_prompt": None,
            "skills": [],
            "topics": [],
            "collaborators": [],
            "enabled": True,
            "created_at": "x",
        },
    ]

    # The helper resolves workspace via bot_id config; use None path by monkeypatching bot_id to tmp.
    # We test pure enrichment path by passing already parsed Agent models.
    from console.server.models.agents import Agent
    from console.server.routers.v1 import agents as agents_router

    parsed = [Agent.model_validate(a) for a in agents]
    original = agents_router.teams_state_path
    try:
        agents_router.teams_state_path = lambda _bot_id: ws / "teams.json"  # type: ignore[assignment]
        enriched = _attach_team_memberships("default", parsed)
    finally:
        agents_router.teams_state_path = original  # type: ignore[assignment]

    by_id = {a.id: a for a in enriched}
    assert by_id["a1"].team_ids == ["tm1"]
    assert by_id["a2"].team_ids == ["tm1", "tm2"]
