"""Tests for syncing ``agents/<id>/profile.json`` from Settings ``agents.defaults``."""

from __future__ import annotations

import json
from pathlib import Path

from console.server.agent_defaults_profile_sync import (
    sync_main_workspace_agent_profile_from_config_defaults,
)
from openpawlet.config.schema import AgentDefaults


def test_sync_updates_sole_profile_json(tmp_path: Path) -> None:
    workspace = tmp_path / "ws"
    ag = workspace / "agents" / "sole"
    ag.mkdir(parents=True)
    profile_path = ag / "profile.json"
    profile_path.write_text(
        json.dumps(
            {
                "id": "sole",
                "name": "S",
                "model": "old/model",
                "temperature": 0.5,
                "skillsDenylist": ["x"],
                "overrides": {"timezone": "UTC"},
            }
        ),
        encoding="utf-8",
    )
    defaults = AgentDefaults(
        model="new/model",
        temperature=0.2,
        timezone="Asia/Tokyo",
        disabled_skills=["skill-a"],
    )
    sync_main_workspace_agent_profile_from_config_defaults(workspace, defaults)

    data = json.loads(profile_path.read_text(encoding="utf-8"))
    assert data["model"] == "new/model"
    assert data["temperature"] == 0.2
    assert data["overrides"]["timezone"] == "Asia/Tokyo"
    assert data["overrides"]["disabled_skills"] == ["skill-a"]
    assert data["skills_denylist"] == ["x"]


def test_sync_prefers_main_when_present(tmp_path: Path) -> None:
    workspace = tmp_path / "ws"
    for aid in ("main", "other"):
        d = workspace / "agents" / aid
        d.mkdir(parents=True)
        (d / "profile.json").write_text(
            json.dumps({"id": aid, "name": aid, "model": f"{aid}/m"}),
            encoding="utf-8",
        )
    defaults = AgentDefaults(model="from/settings")
    sync_main_workspace_agent_profile_from_config_defaults(workspace, defaults)

    main_data = json.loads((workspace / "agents" / "main" / "profile.json").read_text(encoding="utf-8"))
    other_data = json.loads((workspace / "agents" / "other" / "profile.json").read_text(encoding="utf-8"))
    assert main_data["model"] == "from/settings"
    assert other_data["model"] == "other/m"
