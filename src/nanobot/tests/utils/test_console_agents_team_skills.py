"""Tests for team ``team_skills`` allowlist in gateway identity resolution."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

from nanobot.config.schema import AgentDefaults, AgentsConfig, Config
from nanobot.utils.console_agents import resolve_gateway_identity_overrides


def _write_team(workspace: Path, team_id: str, team_skills: list[str]) -> None:
    p = workspace / ".nanobot_console"
    p.mkdir(parents=True, exist_ok=True)
    (p / "teams.json").write_text(
        json.dumps(
            {
                "teams": [
                    {
                        "id": team_id,
                        "name": "T",
                        "member_agent_ids": [],
                        "team_skills": team_skills,
                        "context_notes": None,
                        "created_at": "x",
                    }
                ],
                "rooms": [],
            }
        ),
        encoding="utf-8",
    )


def test_team_skills_merges_disabled_with_defaults(tmp_path: Path) -> None:
    _write_team(tmp_path, "tm1", ["skill-a"])
    cfg = Config(
        agents=AgentsConfig(defaults=AgentDefaults(workspace=str(tmp_path), disabled_skills=["z1"]))
    )
    with patch(
        "nanobot.utils.console_agents.disabled_skills_for_allowlist",
        return_value={"x1", "y1"},
    ) as m_deny:
        _m, disabled, _p = resolve_gateway_identity_overrides(
            cfg, tmp_path, logical_agent_id=None, team_id="tm1"
        )
    m_deny.assert_called_once()
    assert set(disabled or []) == {"x1", "y1", "z1"}


def test_team_skills_intersects_with_agent_allowlist(
    tmp_path: Path,
) -> None:
    """Agent allowlist + team allowlist both add deny-sets; enabled = intersection of allowlists."""
    ag = tmp_path / "agents"
    ag.mkdir(parents=True)
    (ag / "agent1.json").write_text(
        json.dumps(
            {
                "id": "agent1",
                "skills": ["a", "b"],
            }
        ),
        encoding="utf-8",
    )
    _write_team(tmp_path, "tm1", ["b", "c"])
    cfg = Config(agents=AgentsConfig(defaults=AgentDefaults(workspace=str(tmp_path))))
    with patch("nanobot.utils.console_agents.disabled_skills_for_allowlist") as m_deny:
        m_deny.side_effect = [
            {"d1", "d2"},
            {"d3", "d4"},
        ]
        resolve_gateway_identity_overrides(cfg, tmp_path, logical_agent_id="agent1", team_id="tm1")
    assert m_deny.call_count == 2
    calls = m_deny.call_args_list
    assert list(calls[0].args[1]) == ["a", "b"]  # allowlist
    assert list(calls[1].args[1]) == ["b", "c"]  # team
