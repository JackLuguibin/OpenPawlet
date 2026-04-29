"""Multi-agent API under ``/bots/{bot_id}/agents`` with JSON persistence."""

from __future__ import annotations

import contextlib
import re
from typing import Any

from fastapi import APIRouter, status
from pydantic import ValidationError

from console.server.bot_workspace import (
    agent_bootstrap_keys,
    agent_bootstrap_path,
    agent_profile_dir,
    agent_profile_json_path,
    agent_workspace_json_path,
    agents_state_path,
    iso_now,
    load_json_file,
    migrate_agent_profile_layout,
    new_id,
    read_text,
    save_json_file,
    set_bot_running,
    teams_state_path,
    workspace_agents_dir,
    write_text,
)
from console.server.http_errors import bad_request, internal_error, not_found
from console.server.models import (
    AddCategoryBody,
    Agent,
    AgentBootstrapFiles,
    AgentBootstrapUpdateBody,
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
    OkWithKey,
    OkWithTopic,
)
from console.server.parsing import parse_model_list
from console.server.state_hub import publish_agents_update

router = APIRouter(prefix="/bots/{bot_id}/agents", tags=["Agents"])

# UI built-in display categories (must accept overrides even with no custom rows).
_BUILTIN_DISPLAY_CATEGORY_KEYS: frozenset[str] = frozenset(
    {"general", "content", "office"},
)

_CATEGORY_COLORS = (
    "#6366f1",
    "#22c55e",
    "#eab308",
    "#f97316",
    "#ec4899",
    "#14b8a6",
)


def _load_agent_file_dicts(bot_id: str) -> list[dict[str, Any]]:
    """Load agent rows from both new and legacy layouts.

    Discovery order under ``<workspace>/agents/``:

    * ``<id>/profile.json`` — preferred (independent persona layout)
    * ``<id>.json`` — legacy single file (auto-migrated on next write)
    """
    base = workspace_agents_dir(bot_id)
    if not base.is_dir():
        return []
    rows: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for entry in sorted(base.iterdir()):
        if entry.is_dir():
            p = entry / "profile.json"
            if not p.is_file():
                continue
            row = load_json_file(p, None)
        elif entry.is_file() and entry.suffix == ".json":
            row = load_json_file(entry, None)
        else:
            continue
        if isinstance(row, dict):
            rid = str(row.get("id", "")).strip()
            if rid and rid in seen_ids:
                continue
            if rid:
                seen_ids.add(rid)
                # Decorate with has_* flags so the API returns whether
                # bootstrap files exist on disk for this agent.
                row = _decorate_with_bootstrap_flags(bot_id, rid, row)
            rows.append(row)
    rows.sort(key=lambda d: (str(d.get("created_at", "") or ""), str(d.get("id", "") or "")))
    return rows


def _decorate_with_bootstrap_flags(
    bot_id: str, agent_id: str, row: dict[str, Any]
) -> dict[str, Any]:
    """Stamp ``has_soul`` / ``has_user`` / ``has_agents_md`` / ``has_tools_md``."""
    out = dict(row)
    out["has_soul"] = agent_bootstrap_path(bot_id, agent_id, "soul").is_file()
    out["has_user"] = agent_bootstrap_path(bot_id, agent_id, "user").is_file()
    out["has_agents_md"] = agent_bootstrap_path(bot_id, agent_id, "agents").is_file()
    out["has_tools_md"] = agent_bootstrap_path(bot_id, agent_id, "tools").is_file()
    return out


def _migrate_legacy_agents_in_file(
    bot_id: str, agents_legacy: list[Any], data: dict[str, Any]
) -> None:
    """One-time: copy ``.openpawlet_console/agents.json`` ``agents`` array to per-agent dirs."""
    for item in agents_legacy:
        if not isinstance(item, dict):
            continue
        try:
            agent = Agent.model_validate(item)
        except ValidationError:
            continue
        p = agent_profile_json_path(bot_id, agent.id)
        payload = agent.model_dump(mode="json")
        for derived in ("has_soul", "has_user", "has_agents_md", "has_tools_md", "team_ids"):
            payload.pop(derived, None)
        save_json_file(p, payload)
    meta = {
        "categories": data.get("categories") if isinstance(data.get("categories"), list) else [],
        "category_overrides": data.get("category_overrides")
        if isinstance(data.get("category_overrides"), dict)
        else {},
    }
    save_json_file(agents_state_path(bot_id), meta)


def _load_raw_state(bot_id: str) -> dict[str, Any]:
    """Load agent rows from ``workspace/agents/``; metadata from ``.openpawlet_console/agents.json``."""
    path = agents_state_path(bot_id)
    data = load_json_file(path, None)
    if not isinstance(data, dict):
        data = {}
    agents_legacy = data.get("agents")
    if isinstance(agents_legacy, list) and agents_legacy:
        _migrate_legacy_agents_in_file(bot_id, agents_legacy, data)
        data = load_json_file(path, None)
        if not isinstance(data, dict):
            data = {}
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
        "agents": _load_agent_file_dicts(bot_id),
        "categories": cats,
        "category_overrides": overrides,
    }


def _parse_agents(raw_list: list[Any]) -> list[Agent]:
    """Validate stored agent dicts; malformed rows are dropped."""
    return parse_model_list(raw_list, Agent)


def _load_team_memberships(bot_id: str) -> dict[str, list[str]]:
    path = teams_state_path(bot_id)
    data = load_json_file(path, None)
    if not isinstance(data, dict):
        return {}
    teams = data.get("teams")
    if not isinstance(teams, list):
        return {}
    out: dict[str, list[str]] = {}
    for row in teams:
        if not isinstance(row, dict):
            continue
        team_id = str(row.get("id", "")).strip()
        members = row.get("member_agent_ids")
        if not team_id or not isinstance(members, list):
            continue
        for raw in members:
            aid = str(raw).strip()
            if not aid:
                continue
            out.setdefault(aid, []).append(team_id)
    for aid in list(out.keys()):
        out[aid] = sorted(set(out[aid]))
    return out


def _attach_team_memberships(bot_id: str, agents: list[Agent]) -> list[Agent]:
    memberships = _load_team_memberships(bot_id)
    if not memberships:
        return agents
    return [a.model_copy(update={"team_ids": memberships.get(a.id, [])}) for a in agents]


def _parse_categories(raw_list: list[Any]) -> list[CategoryInfo]:
    """Validate stored category dicts; malformed rows are dropped."""
    return parse_model_list(raw_list, CategoryInfo)


def _prune_orphan_agent_entries(bot_id: str, keep_ids: set[str]) -> None:
    """Remove ``agents/<id>.json`` and ``agents/<id>/`` not in ``keep_ids``."""
    import shutil

    base = workspace_agents_dir(bot_id)
    for entry in base.iterdir():
        if entry.is_file() and entry.suffix == ".json":
            if entry.stem not in keep_ids:
                with contextlib.suppress(OSError):
                    entry.unlink()
        elif entry.is_dir() and entry.name not in keep_ids:
            with contextlib.suppress(OSError):
                shutil.rmtree(entry)


def _save_full_state(
    bot_id: str,
    *,
    agents: list[Agent],
    categories: list[CategoryInfo],
    category_overrides: dict[str, str],
) -> None:
    """Persist each agent under ``<workspace>/agents/<id>/profile.json``.

    Also tidies up legacy ``agents/<id>.json`` files for any kept ids.
    Read-only ``has_*`` fields are stripped before persistence so they
    can never drift away from on-disk reality.
    """
    keep_ids = {a.id for a in agents}
    for a in agents:
        migrate_agent_profile_layout(bot_id, a.id)
        p = agent_profile_json_path(bot_id, a.id)
        data = a.model_dump(mode="json")
        for derived in ("has_soul", "has_user", "has_agents_md", "has_tools_md", "team_ids"):
            data.pop(derived, None)
        save_json_file(p, data)
        # Drop the legacy single-file copy if it still exists.
        legacy = agent_workspace_json_path(bot_id, a.id)
        if legacy.is_file():
            with contextlib.suppress(OSError):
                legacy.unlink()
    _prune_orphan_agent_entries(bot_id, keep_ids)
    path = agents_state_path(bot_id)
    payload = {
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
        not_found("Agent")
    if body.category_key is None:
        overrides.pop(body.agent_id, None)
    else:
        valid_keys = _BUILTIN_DISPLAY_CATEGORY_KEYS | {c.key for c in categories}
        if body.category_key not in valid_keys:
            bad_request("Unknown category")
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
    overrides = {aid: ck for aid, ck in raw["category_overrides"].items() if ck != category_key}
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
    return DataResponse(data=_attach_team_memberships(bot_id, _parse_agents(raw["agents"])))


_PROFILE_OVERRIDE_FIELDS: tuple[str, ...] = (
    "max_tokens",
    "max_tool_iterations",
    "max_tool_result_chars",
    "context_window_tokens",
    "reasoning_effort",
    "timezone",
    "web_enabled",
    "exec_enabled",
    "mcp_servers_allowlist",
    "allowed_tools",
    "skills_denylist",
    "use_own_bootstrap",
    "inherit_main_bootstrap",
    "provider_instance_id",
)


def _apply_profile_overrides(
    data: dict[str, Any],
    body: AgentCreateRequest | AgentUpdateRequest,
) -> None:
    """Copy independent-persona override fields from *body* into *data* in place."""
    for field in _PROFILE_OVERRIDE_FIELDS:
        value = getattr(body, field, None)
        if value is not None:
            data[field] = value


@router.post("", response_model=DataResponse[Agent], status_code=status.HTTP_200_OK)
async def create_agent(bot_id: str, body: AgentCreateRequest) -> DataResponse[Agent]:
    """Create an agent record."""
    raw = _load_raw_state(bot_id)
    agents = _parse_agents(raw["agents"])
    categories = _parse_categories(raw["categories"])
    overrides: dict[str, str] = dict(raw["category_overrides"])
    aid = body.id or new_id("agent-")
    if any(a.id == aid for a in agents):
        bad_request("Agent id already exists")
    agent_data: dict[str, Any] = {
        "id": aid,
        "name": body.name,
        "description": body.description,
        "model": body.model,
        "temperature": body.temperature,
        "system_prompt": body.system_prompt,
        "skills": list(body.skills) if body.skills is not None else [],
        "topics": list(body.topics) if body.topics is not None else [],
        "collaborators": (
            list(body.collaborators) if body.collaborators is not None else []
        ),
        "enabled": True if body.enabled is None else body.enabled,
        "created_at": iso_now(),
    }
    _apply_profile_overrides(agent_data, body)
    agent = Agent.model_validate(agent_data)
    agents.append(agent)
    _save_full_state(
        bot_id,
        agents=agents,
        categories=categories,
        category_overrides=overrides,
    )
    set_bot_running(bot_id, True)
    publish_agents_update(bot_id)
    return DataResponse(data=agent.model_copy(update={"team_ids": []}))


@router.get("/{agent_id}", response_model=DataResponse[Agent])
async def get_agent(bot_id: str, agent_id: str) -> DataResponse[Agent]:
    """Get one agent."""
    raw = _load_raw_state(bot_id)
    agents = _parse_agents(raw["agents"])
    for agent in agents:
        if agent.id == agent_id:
            team_ids = _load_team_memberships(bot_id).get(agent.id, [])
            return DataResponse(data=agent.model_copy(update={"team_ids": team_ids}))
    not_found("Agent")


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
        _apply_profile_overrides(data, body)
        updated = Agent.model_validate(data)
        new_list.append(updated)
    if updated is None:
        not_found("Agent")
    _save_full_state(
        bot_id,
        agents=new_list,
        categories=categories,
        category_overrides=overrides,
    )
    publish_agents_update(bot_id)
    team_ids = _load_team_memberships(bot_id).get(updated.id, [])
    return DataResponse(data=updated.model_copy(update={"team_ids": team_ids}))


@router.delete("/{agent_id}", response_model=DataResponse[OkBody])
async def delete_agent(bot_id: str, agent_id: str) -> DataResponse[OkBody]:
    """Delete an agent."""
    raw = _load_raw_state(bot_id)
    agents = [a for a in _parse_agents(raw["agents"]) if a.id != agent_id]
    if len(agents) == len(_parse_agents(raw["agents"])):
        not_found("Agent")
    categories = _parse_categories(raw["categories"])
    overrides = {aid: ck for aid, ck in raw["category_overrides"].items() if aid != agent_id}
    _save_full_state(
        bot_id,
        agents=agents,
        categories=categories,
        category_overrides=overrides,
    )
    publish_agents_update(bot_id)
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
        not_found("Agent")
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
    return DataResponse(data=DelegateTaskResponse(correlation_id="stub", response=None))


@router.post("/{agent_id}/broadcast", response_model=DataResponse[OkWithTopic])
async def broadcast_event(
    bot_id: str,
    agent_id: str,
    body: BroadcastEventRequest,
) -> DataResponse[OkWithTopic]:
    """Broadcast event to subscribers (stub)."""
    _ = bot_id, agent_id
    return DataResponse(data=OkWithTopic(topic=body.topic))


# ---------------------------------------------------------------------------
# Bootstrap files (independent persona)
# ---------------------------------------------------------------------------


def _ensure_agent_exists(bot_id: str, agent_id: str) -> None:
    """Raise 404 when *agent_id* has no record under ``<workspace>/agents/``."""
    raw = _load_raw_state(bot_id)
    if not any(
        isinstance(row, dict) and str(row.get("id", "")).strip() == agent_id
        for row in raw["agents"]
    ):
        not_found("Agent")


@router.get(
    "/{agent_id}/bootstrap",
    response_model=DataResponse[AgentBootstrapFiles],
)
async def get_agent_bootstrap(
    bot_id: str, agent_id: str
) -> DataResponse[AgentBootstrapFiles]:
    """Return SOUL/USER/AGENTS/TOOLS markdown for one agent."""
    _ensure_agent_exists(bot_id, agent_id)
    parts: dict[str, str] = {}
    for key in agent_bootstrap_keys():
        path = agent_bootstrap_path(bot_id, agent_id, key)
        parts[key] = read_text(path) if path.is_file() else ""
    return DataResponse(data=AgentBootstrapFiles(**parts))


@router.put(
    "/{agent_id}/bootstrap/{key}",
    response_model=DataResponse[OkWithKey],
)
async def update_agent_bootstrap(
    bot_id: str,
    agent_id: str,
    key: str,
    body: AgentBootstrapUpdateBody,
) -> DataResponse[OkWithKey]:
    """Write one bootstrap file under ``<workspace>/agents/<id>/``."""
    _ensure_agent_exists(bot_id, agent_id)
    if key not in agent_bootstrap_keys():
        bad_request("Unknown profile key")
    # Ensure the per-agent directory exists (the agent record may have
    # come from the legacy single-file layout).
    agent_profile_dir(bot_id, agent_id).mkdir(parents=True, exist_ok=True)
    path = agent_bootstrap_path(bot_id, agent_id, key)
    write_text(path, body.content)
    return DataResponse(data=OkWithKey(key=key))


@router.delete(
    "/{agent_id}/bootstrap/{key}",
    response_model=DataResponse[OkWithKey],
)
async def delete_agent_bootstrap(
    bot_id: str,
    agent_id: str,
    key: str,
) -> DataResponse[OkWithKey]:
    """Remove one bootstrap file (so the agent inherits from main)."""
    _ensure_agent_exists(bot_id, agent_id)
    if key not in agent_bootstrap_keys():
        bad_request("Unknown profile key")
    path = agent_bootstrap_path(bot_id, agent_id, key)
    if path.is_file():
        try:
            path.unlink()
        except OSError as exc:
            internal_error("Failed to delete file", cause=exc)
    return DataResponse(data=OkWithKey(key=key))
