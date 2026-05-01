from __future__ import annotations

from console.server.models.agents import Agent
from console.server.routers.v1 import agents as agents_mod


def _minimal_agent(**kwargs: object) -> Agent:
    base = {
        "id": "x",
        "name": "X",
        "description": None,
        "model": None,
        "temperature": None,
        "system_prompt": None,
        "skills": [],
        "topics": [],
        "collaborators": [],
        "enabled": True,
        "created_at": "t0",
    }
    base.update(kwargs)
    return Agent.model_validate(base)


def test_merge_prepends_synthetic_main(monkeypatch) -> None:
    def fake_row(bot_id: str) -> Agent:
        return _minimal_agent(id="main", name="Gateway", is_main=True)

    monkeypatch.setattr(agents_mod, "_synthetic_main_agent_row", fake_row)
    sub = _minimal_agent(id="agent-sub", name="Sub", is_main=False)
    out = agents_mod._merge_workspace_agents_with_main("default", [sub])
    assert [a.id for a in out] == ["main", "agent-sub"]
    assert out[0].is_main is True
    assert out[1].is_main is False


def test_merge_marks_existing_main_id() -> None:
    main_like = _minimal_agent(id="main", name="Custom main row", is_main=False)
    sub = _minimal_agent(id="other", name="O", is_main=False)
    out = agents_mod._merge_workspace_agents_with_main("default", [main_like, sub])
    assert [a.id for a in out] == ["main", "other"]
    assert out[0].is_main is True
    assert out[1].is_main is False
