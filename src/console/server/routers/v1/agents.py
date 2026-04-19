"""Multi-agent API under ``/bots/{bot_id}/agents`` with JSON persistence."""

from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import ValidationError

from console.server.bot_workspace import (
    agents_state_path,
    iso_now,
    load_json_file,
    new_id,
    save_json_file,
)
from console.server.models import (
    AddCategoryBody,
    Agent,
    AgentCreateRequest,
    AgentsSystemStatus,
    AgentStatus,
    AgentUpdateRequest,
    BroadcastEventRequest,
    CategoryInfo,
    CategoryOverrideBody,
    DataResponse,
    DelegateTaskRequest,
    DelegateTaskResponse,
    OkBody,
    OkWithTopic,
)

router = APIRouter(prefix="/bots/{bot_id}/agents", tags=["Agents"])

_CATEGORY_COLORS = (
    "#6366f1",
    "#22c55e",
    "#eab308",
    "#f97316",
    "#ec4899",
    "#14b8a6",
)


def _load_raw_state(bot_id: str) -> dict[str, Any]:
    """Load persisted JSON or return empty structures."""
    path = agents_state_path(bot_id)
    data = load_json_file(path, None)
    if not isinstance(data, dict):
        return {"agents": [], "categories": [], "category_overrides": {}}
    agents = data.get("agents")
    if not isinstance(agents, list):
        agents = []
    cats = data.get("categories")
    if not isinstance(cats, list):
        cats = []
    cov = data.get("category_overrides")
    if not isinstance(cov, dict):
        cov = {}
    overrides: dict[str, str] = {}
    for agent_key, cat_key in cov.items():
        if isinstance(agent_key, str) and isinstance(cat_key, str):
            overrides[agent_key] = cat_key
    return {
        "agents": agents,
        "categories": cats,
        "category_overrides": overrides,
    }


def _parse_agents(raw_list: list[Any]) -> list[Agent]:
    """Validate stored agent dicts."""
    out: list[Agent] = []
    for item in raw_list:
        if not isinstance(item, dict):
            continue
        try:
            out.append(Agent.model_validate(item))
        except ValidationError:
            continue
    return out


def _parse_categories(raw_list: list[Any]) -> list[CategoryInfo]:
    """Validate stored category dicts."""
    out: list[CategoryInfo] = []
    for item in raw_list:
        if not isinstance(item, dict):
            continue
        try:
            out.append(CategoryInfo.model_validate(item))
        except ValidationError:
            continue
    return out


def _save_full_state(
    bot_id: str,
    *,
    agents: list[Agent],
    categories: list[CategoryInfo],
    category_overrides: dict[str, str],
) -> None:
    """Write ``agents.json``."""
    path = agents_state_path(bot_id)
    payload = {
        "agents": [a.model_dump(mode="json") for a in agents],
        "categories": [c.model_dump(mode="json") for c in categories],
        "category_overrides": dict(category_overrides),
    }
    save_json_file(path, payload)


def _category_key_from_label(label: str, existing: set[str]) -> str:
    """Derive a unique slug for a new category."""
    base = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-") or "category"
    key = base
    n = 0
    while key in existing:
        n += 1
        key = f"{base}-{n}"
    return key


@router.get("/system-status/status", response_model=DataResponse[AgentsSystemStatus])
async def agents_system_status(bot_id: str) -> DataResponse[AgentsSystemStatus]:
    """Aggregate multi-agent counts from persisted state."""
    raw = _load_raw_state(bot_id)
    agents = _parse_agents(raw["agents"])
    total = len(agents)
    enabled_ct = sum(1 for a in agents if a.enabled)
    return DataResponse(
        data=AgentsSystemStatus(
            total_agents=total,
            enabled_agents=enabled_ct,
            subscribed_agents=[],
            zmq_initialized=False,
            current_agent_id=None,
        )
    )


@router.get("/categories/overrides", response_model=DataResponse[dict[str, str]])
async def get_category_overrides(bot_id: str) -> DataResponse[dict[str, str]]:
    """Return category overrides map."""
    raw = _load_raw_state(bot_id)
    return DataResponse(data=dict(raw["category_overrides"]))


@router.put("/categories/overrides", response_model=DataResponse[dict[str, str]])
async def set_category_override(
    bot_id: str,
    body: CategoryOverrideBody,
) -> DataResponse[dict[str, str]]:
    """Update which category an agent belongs to."""
    raw = _load_raw_state(bot_id)
    agents = _parse_agents(raw["agents"])
    categories = _parse_categories(raw["categories"])
    overrides: dict[str, str] = dict(raw["category_overrides"])
    if not any(a.id == body.agent_id for a in agents):
        raise HTTPException(status_code=404, detail="Agent not found")
    if body.category_key is None:
        overrides.pop(body.agent_id, None)
    else:
        valid_keys = {c.key for c in categories}
        if body.category_key not in valid_keys:
            raise HTTPException(status_code=400, detail="Unknown category")
        overrides[body.agent_id] = body.category_key
    _save_full_state(
        bot_id,
        agents=agents,
        categories=categories,
        category_overrides=overrides,
    )
    return DataResponse(data=overrides)


@router.get("/categories", response_model=DataResponse[list[CategoryInfo]])
async def list_categories(bot_id: str) -> DataResponse[list[CategoryInfo]]:
    """List agent categories."""
    raw = _load_raw_state(bot_id)
    return DataResponse(data=_parse_categories(raw["categories"]))


@router.post(
    "/categories",
    response_model=DataResponse[CategoryInfo],
    status_code=status.HTTP_200_OK,
)
async def add_category(
    bot_id: str,
    body: AddCategoryBody,
) -> DataResponse[CategoryInfo]:
    """Add a category with an auto-generated key and color."""
    raw = _load_raw_state(bot_id)
    agents = _parse_agents(raw["agents"])
    categories = _parse_categories(raw["categories"])
    overrides: dict[str, str] = dict(raw["category_overrides"])
    existing = {c.key for c in categories}
    key = _category_key_from_label(body.label, existing)
    color = _CATEGORY_COLORS[len(categories) % len(_CATEGORY_COLORS)]
    cat = CategoryInfo(key=key, label=body.label, color=color)
    categories.append(cat)
    _save_full_state(
        bot_id,
        agents=agents,
        categories=categories,
        category_overrides=overrides,
    )
    return DataResponse(data=cat)


@router.delete("/categories/{category_key}", response_model=DataResponse[OkBody])
async def remove_category(
    bot_id: str,
    category_key: str,
) -> DataResponse[OkBody]:
    """Remove a category and clear overrides pointing to it."""
    raw = _load_raw_state(bot_id)
    agents = _parse_agents(raw["agents"])
    prev_cats = _parse_categories(raw["categories"])
    categories = [c for c in prev_cats if c.key != category_key]
    overrides = {
        aid: ck
        for aid, ck in raw["category_overrides"].items()
        if ck != category_key
    }
    _save_full_state(
        bot_id,
        agents=agents,
        categories=categories,
        category_overrides=overrides,
    )
    return DataResponse(data=OkBody())


@router.get("", response_model=DataResponse[list[Agent]])
async def list_agents(bot_id: str) -> DataResponse[list[Agent]]:
    """List agents."""
    raw = _load_raw_state(bot_id)
    return DataResponse(data=_parse_agents(raw["agents"]))


@router.post("", response_model=DataResponse[Agent], status_code=status.HTTP_200_OK)
async def create_agent(bot_id: str, body: AgentCreateRequest) -> DataResponse[Agent]:
    """Create an agent record."""
    raw = _load_raw_state(bot_id)
    agents = _parse_agents(raw["agents"])
    categories = _parse_categories(raw["categories"])
    overrides: dict[str, str] = dict(raw["category_overrides"])
    aid = body.id or new_id("agent-")
    if any(a.id == aid for a in agents):
        raise HTTPException(status_code=400, detail="Agent id already exists")
    agent = Agent(
        id=aid,
        name=body.name,
        description=body.description,
        model=body.model,
        temperature=body.temperature,
        system_prompt=body.system_prompt,
        skills=list(body.skills) if body.skills is not None else [],
        topics=list(body.topics) if body.topics is not None else [],
        collaborators=(
            list(body.collaborators) if body.collaborators is not None else []
        ),
        enabled=True if body.enabled is None else body.enabled,
        created_at=iso_now(),
    )
    agents.append(agent)
    _save_full_state(
        bot_id,
        agents=agents,
        categories=categories,
        category_overrides=overrides,
    )
    return DataResponse(data=agent)


@router.get("/{agent_id}", response_model=DataResponse[Agent])
async def get_agent(bot_id: str, agent_id: str) -> DataResponse[Agent]:
    """Get one agent."""
    raw = _load_raw_state(bot_id)
    agents = _parse_agents(raw["agents"])
    for agent in agents:
        if agent.id == agent_id:
            return DataResponse(data=agent)
    raise HTTPException(status_code=404, detail="Agent not found")


@router.put("/{agent_id}", response_model=DataResponse[Agent])
async def update_agent(
    bot_id: str,
    agent_id: str,
    body: AgentUpdateRequest,
) -> DataResponse[Agent]:
    """Update fields on an agent."""
    raw = _load_raw_state(bot_id)
    agents = _parse_agents(raw["agents"])
    categories = _parse_categories(raw["categories"])
    overrides: dict[str, str] = dict(raw["category_overrides"])
    updated: Agent | None = None
    new_list: list[Agent] = []
    for agent in agents:
        if agent.id != agent_id:
            new_list.append(agent)
            continue
        data = agent.model_dump()
        if body.name is not None:
            data["name"] = body.name
        if body.description is not None:
            data["description"] = body.description
        if body.model is not None:
            data["model"] = body.model
        if body.temperature is not None:
            data["temperature"] = body.temperature
        if body.system_prompt is not None:
            data["system_prompt"] = body.system_prompt
        if body.skills is not None:
            data["skills"] = body.skills
        if body.topics is not None:
            data["topics"] = body.topics
        if body.collaborators is not None:
            data["collaborators"] = body.collaborators
        if body.enabled is not None:
            data["enabled"] = body.enabled
        updated = Agent.model_validate(data)
        new_list.append(updated)
    if updated is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    _save_full_state(
        bot_id,
        agents=new_list,
        categories=categories,
        category_overrides=overrides,
    )
    return DataResponse(data=updated)


@router.delete("/{agent_id}", response_model=DataResponse[OkBody])
async def delete_agent(bot_id: str, agent_id: str) -> DataResponse[OkBody]:
    """Delete an agent."""
    raw = _load_raw_state(bot_id)
    agents = [a for a in _parse_agents(raw["agents"]) if a.id != agent_id]
    if len(agents) == len(_parse_agents(raw["agents"])):
        raise HTTPException(status_code=404, detail="Agent not found")
    categories = _parse_categories(raw["categories"])
    overrides = {
        aid: ck
        for aid, ck in raw["category_overrides"].items()
        if aid != agent_id
    }
    _save_full_state(
        bot_id,
        agents=agents,
        categories=categories,
        category_overrides=overrides,
    )
    return DataResponse(data=OkBody())


@router.post("/{agent_id}/enable", response_model=DataResponse[Agent])
async def enable_agent(bot_id: str, agent_id: str) -> DataResponse[Agent]:
    """Enable an agent."""
    return await update_agent(
        bot_id,
        agent_id,
        AgentUpdateRequest(enabled=True),
    )


@router.post("/{agent_id}/disable", response_model=DataResponse[Agent])
async def disable_agent(bot_id: str, agent_id: str) -> DataResponse[Agent]:
    """Disable an agent."""
    return await update_agent(
        bot_id,
        agent_id,
        AgentUpdateRequest(enabled=False),
    )


@router.get("/{agent_id}/status", response_model=DataResponse[AgentStatus])
async def get_agent_status(bot_id: str, agent_id: str) -> DataResponse[AgentStatus]:
    """Per-agent status snapshot."""
    raw = _load_raw_state(bot_id)
    agents = _parse_agents(raw["agents"])
    total = len(agents)
    enabled_ct = sum(1 for a in agents if a.enabled)
    target = next((a for a in agents if a.id == agent_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    return DataResponse(
        data=AgentStatus(
            agent_id=target.id,
            agent_name=target.name,
            enabled=target.enabled,
            total_agents=total,
            enabled_agents=enabled_ct,
            subscribed_agents=[],
            zmq_initialized=False,
            current_agent_id=None,
        )
    )


@router.post(
    "/{agent_id}/delegate",
    response_model=DataResponse[DelegateTaskResponse],
    status_code=status.HTTP_200_OK,
)
async def delegate_task(
    bot_id: str,
    agent_id: str,
    _body: DelegateTaskRequest,
) -> DataResponse[DelegateTaskResponse]:
    """Delegate task to another agent (not wired to a live runtime)."""
    _ = bot_id, agent_id
    return DataResponse(
        data=DelegateTaskResponse(correlation_id="stub", response=None)
    )


@router.post("/{agent_id}/broadcast", response_model=DataResponse[OkWithTopic])
async def broadcast_event(
    bot_id: str,
    agent_id: str,
    body: BroadcastEventRequest,
) -> DataResponse[OkWithTopic]:
    """Broadcast event to subscribers (stub)."""
    _ = bot_id, agent_id
    return DataResponse(data=OkWithTopic(topic=body.topic))
