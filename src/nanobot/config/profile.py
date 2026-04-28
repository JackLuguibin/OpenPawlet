"""Sub-agent profile schema (independent persona / tools / model overrides).

A *profile* gives a sub-agent its own persona files (SOUL.md, USER.md,
AGENTS.md, TOOLS.md), tool whitelist, and overrides for any
:class:`AgentDefaults` / :class:`ToolsConfig` field. Profiles live under
``<workspace>/agents/<id>/`` so they are co-located with the existing
console multi-agent record.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from pydantic import ConfigDict, Field
from pydantic.alias_generators import to_camel

from nanobot.config.schema import (
    AgentDefaults,
    Base,
    ExecToolConfig,
    MCPServerConfig,
    MyToolConfig,
    ToolsConfig,
    WebSearchConfig,
    WebToolsConfig,
)


class WebSearchOverride(Base):
    """Optional override for :class:`WebSearchConfig`."""

    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid"
    )

    provider: str | None = None
    api_key: str | None = None
    base_url: str | None = None
    max_results: int | None = None
    timeout: int | None = None


_CAMEL = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class WebToolsOverride(Base):
    """Optional override for :class:`WebToolsConfig`."""

    model_config = _CAMEL

    enable: bool | None = None
    proxy: str | None = None
    search: WebSearchOverride | None = None


class ExecToolOverride(Base):
    """Optional override for :class:`ExecToolConfig`."""

    model_config = _CAMEL

    enable: bool | None = None
    timeout: int | None = None
    path_append: str | None = None
    sandbox: str | None = None
    allowed_env_keys: list[str] | None = None


class MyToolOverride(Base):
    """Optional override for :class:`MyToolConfig`."""

    model_config = _CAMEL

    enable: bool | None = None
    allow_set: bool | None = None


class ToolsConfigOverride(Base):
    """Per-profile overrides for :class:`ToolsConfig`.

    Any field set to ``None`` (or omitted) means *inherit from main*.
    Lists/dicts replace the main value entirely when present (we never
    auto-merge MCP server dicts to keep behaviour predictable).
    """

    model_config = _CAMEL

    web: WebToolsOverride | None = None
    exec: ExecToolOverride | None = None
    my: MyToolOverride | None = None
    restrict_to_workspace: bool | None = None
    mcp_servers: dict[str, MCPServerConfig] | None = None
    mcp_servers_allowlist: list[str] | None = None  # Subset of main's mcp_servers keys; None = all
    ssrf_whitelist: list[str] | None = None


class AgentDefaultsOverride(Base):
    """Per-profile overrides for :class:`AgentDefaults`.

    Workspace cannot be overridden here — the profile shares the parent
    workspace; it only gets its own bootstrap files in a sub-directory.
    """

    model_config = _CAMEL

    model: str | None = None
    provider: str | None = None
    max_tokens: int | None = None
    context_window_tokens: int | None = None
    context_block_limit: int | None = None
    temperature: float | None = None
    max_tool_iterations: int | None = None
    max_tool_result_chars: int | None = None
    provider_retry_mode: Literal["standard", "persistent"] | None = None
    reasoning_effort: str | None = None
    timezone: str | None = None
    disabled_skills: list[str] | None = None


class AgentProfile(Base):
    """Sub-agent profile record persisted as ``profile.json``.

    Fields kept compatible with the existing console agent record on a
    best-effort basis: ``id`` / ``name`` / ``description`` / ``model`` /
    ``temperature`` / ``system_prompt`` / ``skills`` mirror
    :class:`console.server.models.agents.Agent`. Newer fields live under
    ``overrides`` / ``tools_overrides`` / ``allowed_tools`` etc.
    """

    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="ignore"
    )

    id: str
    name: str = ""
    description: str | None = None

    # Console-compatible direct fields (mirror Agent record).
    model: str | None = None
    temperature: float | None = None
    system_prompt: str | None = None  # Extra system block (Console "context note" semantics)
    skills: list[str] | None = None  # Skill *allowlist*; None = inherit main

    # Full overrides (any field can be ``None`` to inherit).
    overrides: AgentDefaultsOverride = Field(default_factory=AgentDefaultsOverride)
    tools_overrides: ToolsConfigOverride = Field(default_factory=ToolsConfigOverride)

    # Tool whitelist by tool *name* (not skill name). ``None`` = inherit
    # the parent agent's tool set; an empty list = block everything.
    allowed_tools: list[str] | None = None
    skills_denylist: list[str] = Field(default_factory=list)

    # Whether to read this profile's own SOUL/USER/AGENTS/TOOLS markdown.
    use_own_bootstrap: bool = True
    # Whether to also pull the main workspace's SOUL/USER/AGENTS/TOOLS in
    # addition to the profile's own files.
    inherit_main_bootstrap: bool = False

    # ``enabled=True`` means the EmbeddedNanobot reconciler should keep a
    # standalone event loop running for this agent so it can receive its
    # ``agent.<id>`` direct messages and broadcast topics without having
    # to be a team member. Mirrors the Console Agent record's enabled
    # toggle. Default ``True`` preserves prior behaviour for inline
    # profiles spawned ad-hoc by SubagentManager.
    enabled: bool = True


# ---------------------------------------------------------------------------
# Merge helpers
# ---------------------------------------------------------------------------


def _override_dict(model: Any) -> dict[str, Any]:
    """Return only fields that were explicitly set (alias-aware)."""
    if model is None:
        return {}
    return model.model_dump(exclude_none=True, by_alias=False)


def merge_agent_defaults(base: AgentDefaults, override: AgentDefaultsOverride) -> AgentDefaults:
    """Return a new :class:`AgentDefaults` with override fields applied."""
    data = base.model_dump(by_alias=False)
    data.update(_override_dict(override))
    return AgentDefaults.model_validate(data)


def _merge_web_config(base: WebToolsConfig, override: WebToolsOverride | None) -> WebToolsConfig:
    if override is None:
        return base
    data = base.model_dump(by_alias=False)
    if override.enable is not None:
        data["enable"] = override.enable
    if override.proxy is not None:
        data["proxy"] = override.proxy
    if override.search is not None:
        search_data = base.search.model_dump(by_alias=False)
        search_data.update(_override_dict(override.search))
        data["search"] = WebSearchConfig.model_validate(search_data).model_dump(by_alias=False)
    return WebToolsConfig.model_validate(data)


def _merge_exec_config(base: ExecToolConfig, override: ExecToolOverride | None) -> ExecToolConfig:
    if override is None:
        return base
    data = base.model_dump(by_alias=False)
    data.update(_override_dict(override))
    return ExecToolConfig.model_validate(data)


def _merge_my_config(base: MyToolConfig, override: MyToolOverride | None) -> MyToolConfig:
    if override is None:
        return base
    data = base.model_dump(by_alias=False)
    data.update(_override_dict(override))
    return MyToolConfig.model_validate(data)


def merge_tools_config(base: ToolsConfig, override: ToolsConfigOverride) -> ToolsConfig:
    """Return a new :class:`ToolsConfig` with the profile's overrides applied.

    The MCP allowlist (``mcp_servers_allowlist``) further restricts the
    base ``mcp_servers`` map: only keys present in the allowlist (when
    set) are kept. An explicit ``mcp_servers`` dict on the override fully
    replaces the base map.
    """
    web = _merge_web_config(base.web, override.web)
    exec_cfg = _merge_exec_config(base.exec, override.exec)
    my = _merge_my_config(base.my, override.my)
    restrict = (
        override.restrict_to_workspace
        if override.restrict_to_workspace is not None
        else base.restrict_to_workspace
    )
    if override.mcp_servers is not None:
        mcp_servers = dict(override.mcp_servers)
    else:
        mcp_servers = dict(base.mcp_servers)
    if override.mcp_servers_allowlist is not None:
        allow = set(override.mcp_servers_allowlist)
        mcp_servers = {k: v for k, v in mcp_servers.items() if k in allow}
    ssrf = (
        list(override.ssrf_whitelist)
        if override.ssrf_whitelist is not None
        else list(base.ssrf_whitelist)
    )
    return ToolsConfig(
        web=web,
        exec=exec_cfg,
        my=my,
        restrict_to_workspace=restrict,
        mcp_servers=mcp_servers,
        ssrf_whitelist=ssrf,
    )


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------


PROFILE_BOOTSTRAP_FILES: dict[str, str] = {
    "soul": "SOUL.md",
    "user": "USER.md",
    "agents": "AGENTS.md",
    "tools": "TOOLS.md",
}


def workspace_profiles_root(workspace: Path) -> Path:
    """``<workspace>/agents`` — shared with console multi-agent storage."""
    return workspace / "agents"


def profile_dir(workspace: Path, profile_id: str) -> Path:
    """``<workspace>/agents/<id>/`` — the per-profile directory."""
    pid = (profile_id or "").strip()
    if not pid or "/" in pid or ".." in pid or pid != Path(pid).name:
        raise ValueError(f"Invalid profile id: {profile_id!r}")
    return workspace_profiles_root(workspace) / pid


def profile_json_path(workspace: Path, profile_id: str) -> Path:
    """``<workspace>/agents/<id>/profile.json``."""
    return profile_dir(workspace, profile_id) / "profile.json"


def profile_legacy_json_path(workspace: Path, profile_id: str) -> Path:
    """``<workspace>/agents/<id>.json`` (pre-migration single-file layout)."""
    return workspace_profiles_root(workspace) / f"{profile_id}.json"


def profile_bootstrap_path(workspace: Path, profile_id: str, key: str) -> Path:
    """``<workspace>/agents/<id>/SOUL.md`` (or USER/AGENTS/TOOLS)."""
    if key not in PROFILE_BOOTSTRAP_FILES:
        raise ValueError(f"Unknown profile bootstrap key: {key!r}")
    return profile_dir(workspace, profile_id) / PROFILE_BOOTSTRAP_FILES[key]


def profile_memory_dir(workspace: Path, profile_id: str) -> Path:
    """``<workspace>/agents/<id>/memory/``."""
    return profile_dir(workspace, profile_id) / "memory"


def load_profile_json(path: Path) -> AgentProfile | None:
    """Read ``profile.json`` (or legacy single-file json) into an :class:`AgentProfile`."""
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    if "id" not in data:
        # Legacy console agent json may omit; fall back to filename stem.
        data = {**data, "id": path.parent.name if path.name == "profile.json" else path.stem}
    try:
        return AgentProfile.model_validate(data)
    except Exception:
        return None


def save_profile_json(path: Path, profile: AgentProfile) -> None:
    """Atomically write ``profile.json``."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = profile.model_dump(mode="json", exclude_none=False)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)
