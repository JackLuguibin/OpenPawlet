from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException

from console.server.models.agents import Agent, AgentBootstrapUpdateBody, AgentUpdateRequest
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


@pytest.mark.asyncio
async def test_get_agent_bootstrap_main_reads_workspace_profile(
    monkeypatch, tmp_path: Path
) -> None:
    (tmp_path / "SOUL.md").write_text("soul-root", encoding="utf-8")
    paths = {
        "soul": tmp_path / "SOUL.md",
        "user": tmp_path / "USER.md",
        "agents": tmp_path / "AGENTS.md",
        "tools": tmp_path / "TOOLS.md",
    }

    def fake_profile_path(bot_id: str | None, key: str) -> Path:
        return paths[key]

    monkeypatch.setattr(agents_mod, "profile_file_path", fake_profile_path)

    resp = await agents_mod.get_agent_bootstrap("any-bot", agents_mod._MAIN_AGENT_LIST_ID)
    assert resp.data.soul == "soul-root"
    assert resp.data.user == ""


@pytest.mark.asyncio
async def test_put_main_gateway_rejected() -> None:
    with pytest.raises(HTTPException) as ei:
        await agents_mod.update_agent("bid", agents_mod._MAIN_AGENT_LIST_ID, AgentUpdateRequest())
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_delete_main_gateway_rejected() -> None:
    with pytest.raises(HTTPException) as ei:
        await agents_mod.delete_agent("bid", agents_mod._MAIN_AGENT_LIST_ID)
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_bootstrap_put_main_gateway_rejected(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        agents_mod,
        "_ensure_agent_exists",
        lambda _bid, _aid: None,
    )
    body = AgentBootstrapUpdateBody(content="x")
    with pytest.raises(HTTPException) as ei:
        await agents_mod.update_agent_bootstrap(
            "bid",
            agents_mod._MAIN_AGENT_LIST_ID,
            "soul",
            body,
        )
    assert ei.value.status_code == 400

