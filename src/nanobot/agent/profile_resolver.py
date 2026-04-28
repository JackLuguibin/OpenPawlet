"""Profile loading and resolution for sub-agents.

A *resolved* profile bundles the materialised :class:`AgentDefaults`,
:class:`ToolsConfig`, an effective skill denylist, an explicit tool
whitelist, and the prompt fragments that make up the sub-agent's
identity. ``SubagentManager`` and the gateway/team router use the same
resolver so independent personas behave consistently across both call
paths.
"""

from __future__ import annotations

import json
import platform
from dataclasses import dataclass
from pathlib import Path

from nanobot.agent.skills import SkillsLoader
from nanobot.config.profile import (
    PROFILE_BOOTSTRAP_FILES,
    AgentProfile,
    load_profile_json,
    merge_agent_defaults,
    merge_tools_config,
    profile_bootstrap_path,
    profile_dir,
    profile_json_path,
    profile_legacy_json_path,
    save_profile_json,
    workspace_profiles_root,
)
from nanobot.config.schema import (
    AgentDefaults,
    ExecToolConfig,
    MCPServerConfig,
    ToolsConfig,
    WebToolsConfig,
)
from nanobot.utils.prompt_templates import render_template


@dataclass(slots=True)
class ResolvedProfile:
    """Materialised configuration for one sub-agent run.

    All fields are concrete (no ``None`` for optional schema fields):
    callers can treat this like an :class:`AgentDefaults` /
    :class:`ToolsConfig` pair plus the persona prompt and tool/skill
    gates.
    """

    profile: AgentProfile
    defaults: AgentDefaults
    tools: ToolsConfig
    disabled_skills: set[str]
    allowed_tools: set[str] | None  # ``None`` = inherit (no whitelist)
    extra_system_prompt: str | None  # console-style ``system_prompt``
    bootstrap_text: str  # SOUL/USER/AGENTS/TOOLS rendered block
    # When set, the runtime should build a dedicated provider for this
    # profile via ``build_provider_for_instance(instance_id=...)`` and use
    # it instead of the inherited main-agent provider.
    provider_instance_id: str | None = None

    @property
    def model(self) -> str:
        return self.defaults.model

    @property
    def max_tool_result_chars(self) -> int:
        return self.defaults.max_tool_result_chars

    @property
    def restrict_to_workspace(self) -> bool:
        return self.tools.restrict_to_workspace

    @property
    def web_config(self) -> WebToolsConfig:
        return self.tools.web

    @property
    def exec_config(self) -> ExecToolConfig:
        return self.tools.exec

    @property
    def mcp_servers(self) -> dict[str, MCPServerConfig]:
        return dict(self.tools.mcp_servers)


class ProfileStore:
    """Filesystem-backed loader for :class:`AgentProfile` records.

    The store works with both the new ``<workspace>/agents/<id>/profile.json``
    layout (with sibling SOUL/USER/AGENTS/TOOLS Markdown) and the legacy
    flat ``<workspace>/agents/<id>.json`` Console records, transparently
    migrating the latter on first read.
    """

    def __init__(self, workspace: Path) -> None:
        self.workspace = workspace

    # ------------------------------------------------------------------
    # Path helpers
    # ------------------------------------------------------------------

    def root(self) -> Path:
        return workspace_profiles_root(self.workspace)

    def profile_dir(self, profile_id: str) -> Path:
        return profile_dir(self.workspace, profile_id)

    def bootstrap_path(self, profile_id: str, key: str) -> Path:
        return profile_bootstrap_path(self.workspace, profile_id, key)

    # ------------------------------------------------------------------
    # Load / save / list / migrate
    # ------------------------------------------------------------------

    def list_profiles(self) -> list[AgentProfile]:
        """Return every persisted profile (sorted by id)."""
        base = self.root()
        if not base.is_dir():
            return []
        out: list[AgentProfile] = []
        seen: set[str] = set()
        for entry in sorted(base.iterdir(), key=lambda p: p.name):
            if entry.is_dir():
                p = entry / "profile.json"
                if not p.is_file():
                    continue
                profile = load_profile_json(p)
            elif entry.is_file() and entry.suffix == ".json":
                profile = load_profile_json(entry)
            else:
                continue
            if profile is None or profile.id in seen:
                continue
            seen.add(profile.id)
            out.append(profile)
        return out

    def load(self, profile_id: str) -> AgentProfile | None:
        """Return the profile for *profile_id*, migrating legacy files lazily."""
        pid = (profile_id or "").strip()
        if not pid:
            return None
        # Preferred layout.
        new_path = profile_json_path(self.workspace, pid)
        if new_path.is_file():
            return load_profile_json(new_path)
        # Legacy single-file layout.
        legacy = profile_legacy_json_path(self.workspace, pid)
        if legacy.is_file():
            profile = load_profile_json(legacy)
            if profile is not None:
                self._migrate_legacy(legacy, profile)
                return profile
        return None

    def save(self, profile: AgentProfile) -> None:
        """Persist *profile* under the new directory layout."""
        save_profile_json(profile_json_path(self.workspace, profile.id), profile)

    def write_bootstrap(self, profile_id: str, key: str, content: str) -> None:
        """Write one bootstrap file under the profile's directory."""
        path = self.bootstrap_path(profile_id, key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def read_bootstrap(self, profile_id: str, key: str) -> str:
        path = self.bootstrap_path(profile_id, key)
        if path.is_file():
            try:
                return path.read_text(encoding="utf-8")
            except (OSError, UnicodeError):
                return ""
        return ""

    def delete_bootstrap(self, profile_id: str, key: str) -> bool:
        path = self.bootstrap_path(profile_id, key)
        if path.is_file():
            try:
                path.unlink()
                return True
            except OSError:
                return False
        return False

    def has_bootstrap(self, profile_id: str, key: str) -> bool:
        return self.bootstrap_path(profile_id, key).is_file()

    def _migrate_legacy(self, legacy_path: Path, profile: AgentProfile) -> None:
        """Move ``agents/<id>.json`` content into ``agents/<id>/profile.json``."""
        target = profile_json_path(self.workspace, profile.id)
        if target == legacy_path:
            return
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            payload = legacy_path.read_text(encoding="utf-8")
            target.write_text(payload, encoding="utf-8")
            legacy_path.unlink(missing_ok=True)
        except OSError:
            # Best-effort: leave both files in place; future loads will keep
            # working off the legacy file.
            return


# ---------------------------------------------------------------------------
# Resolution: AgentProfile + Config -> ResolvedProfile
# ---------------------------------------------------------------------------


def _allowed_tools_set(profile: AgentProfile) -> set[str] | None:
    if profile.allowed_tools is None:
        return None
    return {str(name).strip() for name in profile.allowed_tools if str(name).strip()}


def _disabled_skills(
    profile: AgentProfile,
    workspace: Path,
    base_disabled: list[str] | set[str] | None,
) -> set[str]:
    """Combine main-agent disabled skills, profile allowlist, and denylist."""
    disabled: set[str] = {str(s) for s in (base_disabled or [])}
    disabled.update(profile.skills_denylist)
    allowlist = profile.skills if profile.skills is not None else None
    # Mirror console_agents.disabled_skills_for_allowlist semantics: allow
    # only listed skills by adding everything else to ``disabled``.
    if allowlist is not None:
        allow = {str(x).strip() for x in allowlist if str(x).strip()}
        loader = SkillsLoader(workspace, disabled_skills=set())
        all_names = {s["name"] for s in loader.list_skills(filter_unavailable=False)}
        disabled |= all_names - allow
    return disabled


def resolve_profile(
    profile: AgentProfile,
    *,
    base_defaults: AgentDefaults,
    base_tools: ToolsConfig,
    workspace: Path,
) -> ResolvedProfile:
    """Materialise *profile* into a :class:`ResolvedProfile`.

    Direct console-compatible fields (``model`` / ``temperature``) take
    precedence over ``overrides`` so editing the simple fields in the UI
    keeps working without round-tripping through ``overrides``.
    """
    overrides = profile.overrides.model_copy()
    if profile.model is not None and overrides.model is None:
        overrides.model = profile.model
    if profile.temperature is not None and overrides.temperature is None:
        overrides.temperature = profile.temperature
    # Direct ``provider_instance_id`` on the profile takes precedence
    # over the same field nested under ``overrides``.
    instance_id = (profile.provider_instance_id or overrides.provider_instance_id or "").strip()

    defaults = merge_agent_defaults(base_defaults, overrides)
    tools = merge_tools_config(base_tools, profile.tools_overrides)
    disabled = _disabled_skills(profile, workspace, defaults.disabled_skills)
    allowed = _allowed_tools_set(profile)

    bootstrap_text = build_profile_bootstrap_text(profile, workspace)

    extra_prompt: str | None = None
    if profile.system_prompt and str(profile.system_prompt).strip():
        extra_prompt = str(profile.system_prompt).strip()

    return ResolvedProfile(
        profile=profile,
        defaults=defaults,
        tools=tools,
        disabled_skills=disabled,
        allowed_tools=allowed,
        extra_system_prompt=extra_prompt,
        bootstrap_text=bootstrap_text,
        provider_instance_id=instance_id or None,
    )


# ---------------------------------------------------------------------------
# Prompt assembly
# ---------------------------------------------------------------------------


def build_profile_bootstrap_text(profile: AgentProfile, workspace: Path) -> str:
    """Render the SOUL/USER/AGENTS/TOOLS block for the profile.

    Order: profile-owned files first (when ``use_own_bootstrap``), then the
    main workspace's bootstrap (when ``inherit_main_bootstrap``).
    """
    sections: list[str] = []

    if profile.use_own_bootstrap:
        for key, filename in PROFILE_BOOTSTRAP_FILES.items():
            path = profile_bootstrap_path(workspace, profile.id, key)
            if path.is_file():
                try:
                    content = path.read_text(encoding="utf-8")
                except (OSError, UnicodeError):
                    continue
                if content.strip():
                    sections.append(f"## {filename}\n\n{content}")

    if profile.inherit_main_bootstrap:
        # Match :data:`ContextBuilder.BOOTSTRAP_FILES` ordering.
        for filename in ("AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md"):
            path = workspace / filename
            if path.is_file():
                try:
                    content = path.read_text(encoding="utf-8")
                except (OSError, UnicodeError):
                    continue
                if content.strip():
                    sections.append(f"## (main) {filename}\n\n{content}")

    return "\n\n".join(sections)


def build_profile_system_prompt(
    resolved: ResolvedProfile,
    *,
    workspace: Path,
    channel: str | None = None,
    chat_id: str | None = None,
    timezone: str | None = None,
) -> str:
    """Assemble the full system prompt for a profile-driven sub-agent.

    Layout::

        # Identity (workspace, runtime, platform policy)
        ---
        # Persona — name / description (when set)
        ---
        # Bootstrap (own SOUL/USER/AGENTS/TOOLS; optional main fallback)
        ---
        # Console agent instructions (extra_system_prompt)
        ---
        ## Skills (summary, filtered by allowlist/denylist)

    The base subagent_system.md template is *not* used because that
    block intentionally omits the identity / bootstrap framing — when a
    sub-agent runs with its own persona we want the full identity stack.
    """
    parts: list[str] = []

    workspace_path = str(Path(workspace).expanduser().resolve())
    system = platform.system()
    runtime = (
        f"{'macOS' if system == 'Darwin' else system} {platform.machine()}, "
        f"Python {platform.python_version()}"
    )
    parts.append(
        render_template(
            "agent/identity.md",
            workspace_path=workspace_path,
            runtime=runtime,
            platform_policy=render_template("agent/platform_policy.md", system=system),
            channel=channel or "",
        )
    )

    profile = resolved.profile
    persona_lines: list[str] = []
    if profile.name:
        persona_lines.append(f"# Persona — {profile.name}")
    else:
        persona_lines.append(f"# Persona — {profile.id}")
    if profile.description:
        persona_lines.append("")
        persona_lines.append(profile.description.strip())
    parts.append("\n".join(persona_lines))

    if resolved.bootstrap_text.strip():
        parts.append(resolved.bootstrap_text.strip())

    if resolved.extra_system_prompt:
        parts.append(f"# Console agent instructions\n\n{resolved.extra_system_prompt}")

    skills_loader = SkillsLoader(workspace, disabled_skills=resolved.disabled_skills)
    skills_summary = skills_loader.build_skills_summary()
    if skills_summary:
        parts.append(render_template("agent/skills_section.md", skills_summary=skills_summary))

    return "\n\n---\n\n".join(parts)


# ---------------------------------------------------------------------------
# Convenience: tool-name → constructor gating
# ---------------------------------------------------------------------------


def is_tool_allowed(name: str, allowed: set[str] | None) -> bool:
    """Return True when *name* is permitted (no whitelist = always allowed)."""
    if allowed is None:
        return True
    return name in allowed


def describe_resolution(resolved: ResolvedProfile) -> str:
    """Compact JSON-like description for logs / debug responses."""
    return json.dumps(
        {
            "id": resolved.profile.id,
            "model": resolved.defaults.model,
            "temperature": resolved.defaults.temperature,
            "max_tokens": resolved.defaults.max_tokens,
            "web_enabled": resolved.tools.web.enable,
            "exec_enabled": resolved.tools.exec.enable,
            "allowed_tools": sorted(resolved.allowed_tools)
            if resolved.allowed_tools is not None
            else None,
            "disabled_skills": sorted(resolved.disabled_skills),
            "use_own_bootstrap": resolved.profile.use_own_bootstrap,
            "inherit_main_bootstrap": resolved.profile.inherit_main_bootstrap,
        },
        ensure_ascii=False,
    )
