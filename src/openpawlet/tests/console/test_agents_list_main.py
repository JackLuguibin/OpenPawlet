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


def test_materialize_main_if_missing_persists_synthetic(monkeypatch) -> None:
    """Synthetic gateway row must become a workspace profile so PUT /agents/main succeeds."""
    saved_ids: list[list[str]] = []

    def load_state(_bot_id: str) -> dict:
        return {"agents": [], "categories": [], "category_overrides": {}}

    def record_save(_bot_id: str, *, agents: list, categories, category_overrides) -> None:
        saved_ids.append([a.id for a in agents])

    monkeypatch.setattr(agents_mod, "_load_raw_state", load_state)
    monkeypatch.setattr(agents_mod, "_save_full_state", record_save)
    monkeypatch.setattr(
        agents_mod,
        "_synthetic_main_agent_row",
        lambda _bid: _minimal_agent(id="main", name="Gateway", is_main=True),
    )
    monkeypatch.setattr(agents_mod, "publish_agents_update", lambda _bid: None)

    agents_mod._materialize_main_if_missing("bot-a")
    assert saved_ids == [["main"]]


def test_materialize_main_if_missing_is_idempotent(monkeypatch) -> None:
    main_row = _minimal_agent(id="main", name="Gateway", is_main=True)
    raw: dict = {
        "agents": [main_row.model_dump(mode="json")],
        "categories": [],
        "category_overrides": {},
    }

    def load_state(_bot_id: str) -> dict:
        return raw

    calls: list[int] = []

    def record_save(_bot_id: str, *, agents: list, categories, category_overrides) -> None:
        calls.append(len(agents))

    monkeypatch.setattr(agents_mod, "_load_raw_state", load_state)
    monkeypatch.setattr(agents_mod, "_save_full_state", record_save)
    monkeypatch.setattr(agents_mod, "_synthetic_main_agent_row", lambda _bid: main_row)
    monkeypatch.setattr(agents_mod, "publish_agents_update", lambda _bid: None)

    agents_mod._materialize_main_if_missing("bot-b")
    assert calls == []
