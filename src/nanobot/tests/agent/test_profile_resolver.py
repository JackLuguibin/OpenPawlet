"""Tests for :mod:`nanobot.agent.profile_resolver`."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from nanobot.agent.profile_resolver import (
    ProfileStore,
    build_profile_bootstrap_text,
    build_profile_system_prompt,
    is_tool_allowed,
    resolve_profile,
)
from nanobot.config.profile import (
    AgentDefaultsOverride,
    AgentProfile,
    ToolsConfigOverride,
)
from nanobot.config.schema import AgentDefaults, ToolsConfig


def _store(tmp_path: Path) -> ProfileStore:
    return ProfileStore(tmp_path)


def test_save_and_load_roundtrip(tmp_path: Path) -> None:
    store = _store(tmp_path)
    profile = AgentProfile(
        id="researcher",
        name="Researcher",
        description="Deep dive specialist",
        overrides=AgentDefaultsOverride(model="gpt-5", temperature=0.7),
        allowed_tools=["read_file", "grep"],
    )
    store.save(profile)
    loaded = store.load("researcher")
    assert loaded is not None
    assert loaded.id == "researcher"
    assert loaded.overrides.model == "gpt-5"
    assert loaded.allowed_tools == ["read_file", "grep"]


def test_legacy_single_file_is_migrated(tmp_path: Path) -> None:
    legacy_dir = tmp_path / "agents"
    legacy_dir.mkdir(parents=True)
    legacy_path = legacy_dir / "old-id.json"
    legacy_path.write_text(
        json.dumps(
            {
                "id": "old-id",
                "name": "Legacy",
                "description": None,
                "model": None,
                "temperature": None,
                "system_prompt": None,
                "skills": [],
                "topics": [],
                "collaborators": [],
                "enabled": True,
                "created_at": "2026-01-01T00:00:00Z",
            }
        )
    )

    store = _store(tmp_path)
    loaded = store.load("old-id")
    assert loaded is not None
    assert loaded.id == "old-id"
    assert not legacy_path.exists()
    assert (tmp_path / "agents" / "old-id" / "profile.json").is_file()


def test_resolve_inherits_when_overrides_empty(tmp_path: Path) -> None:
    profile = AgentProfile(id="vanilla", name="Vanilla")
    base_defaults = AgentDefaults(model="claude-default", temperature=0.2, max_tokens=12_000)
    base_tools = ToolsConfig()

    resolved = resolve_profile(
        profile,
        base_defaults=base_defaults,
        base_tools=base_tools,
        workspace=tmp_path,
    )

    assert resolved.model == "claude-default"
    assert resolved.defaults.temperature == 0.2
    assert resolved.defaults.max_tokens == 12_000
    assert resolved.allowed_tools is None  # No whitelist => inherit
    assert resolved.tools.exec.enable is True
    assert resolved.bootstrap_text == ""


def test_resolve_applies_model_and_tools_overrides(tmp_path: Path) -> None:
    profile = AgentProfile(
        id="tight",
        name="Tight",
        overrides=AgentDefaultsOverride(model="gemini", temperature=0.9, max_tokens=2_000),
        tools_overrides=ToolsConfigOverride(),
        allowed_tools=["read_file", "grep"],
    )
    profile.tools_overrides.exec = None  # keep base
    profile.tools_overrides.web = None
    base_defaults = AgentDefaults()
    base_tools = ToolsConfig()
    resolved = resolve_profile(
        profile,
        base_defaults=base_defaults,
        base_tools=base_tools,
        workspace=tmp_path,
    )
    assert resolved.model == "gemini"
    assert resolved.defaults.temperature == 0.9
    assert resolved.defaults.max_tokens == 2_000
    assert resolved.allowed_tools == {"read_file", "grep"}


def test_direct_console_fields_take_precedence(tmp_path: Path) -> None:
    profile = AgentProfile(id="x", name="X", model="m-direct", temperature=0.55)
    base = AgentDefaults()
    resolved = resolve_profile(profile, base_defaults=base, base_tools=ToolsConfig(), workspace=tmp_path)
    assert resolved.model == "m-direct"
    assert resolved.defaults.temperature == 0.55


def test_bootstrap_uses_own_files_only(tmp_path: Path) -> None:
    store = _store(tmp_path)
    profile = AgentProfile(id="solo", name="Solo")
    store.save(profile)
    store.write_bootstrap("solo", "soul", "# I am solo")
    # Main workspace also has a SOUL.md but profile must not pull it in.
    (tmp_path / "SOUL.md").write_text("# Main bot soul")

    text = build_profile_bootstrap_text(profile, tmp_path)
    assert "I am solo" in text
    assert "Main bot soul" not in text


def test_bootstrap_inherits_main_when_flag_set(tmp_path: Path) -> None:
    store = _store(tmp_path)
    profile = AgentProfile(id="hybrid", name="Hybrid", inherit_main_bootstrap=True)
    store.save(profile)
    store.write_bootstrap("hybrid", "soul", "# Custom soul")
    (tmp_path / "SOUL.md").write_text("# Main soul")
    (tmp_path / "AGENTS.md").write_text("# Main agents")

    text = build_profile_bootstrap_text(profile, tmp_path)
    assert "Custom soul" in text
    assert "Main soul" in text
    assert "Main agents" in text


def test_bootstrap_disabled_when_use_own_false(tmp_path: Path) -> None:
    store = _store(tmp_path)
    profile = AgentProfile(id="empty", name="Empty", use_own_bootstrap=False)
    store.save(profile)
    store.write_bootstrap("empty", "soul", "# Should be ignored")

    text = build_profile_bootstrap_text(profile, tmp_path)
    assert text == ""


def test_skills_allowlist_disables_others(tmp_path: Path) -> None:
    # Create a fake workspace skill so SkillsLoader has something to compare to.
    (tmp_path / "skills" / "alpha").mkdir(parents=True)
    (tmp_path / "skills" / "alpha" / "SKILL.md").write_text("---\nname: alpha\n---\nalpha")
    (tmp_path / "skills" / "beta").mkdir(parents=True)
    (tmp_path / "skills" / "beta" / "SKILL.md").write_text("---\nname: beta\n---\nbeta")
    profile = AgentProfile(id="x", name="X", skills=["alpha"])
    resolved = resolve_profile(
        profile,
        base_defaults=AgentDefaults(),
        base_tools=ToolsConfig(),
        workspace=tmp_path,
    )
    # beta is not in allowlist → should appear in disabled set.
    assert "beta" in resolved.disabled_skills
    assert "alpha" not in resolved.disabled_skills


def test_is_tool_allowed_inherits_when_none() -> None:
    assert is_tool_allowed("exec", None) is True


def test_is_tool_allowed_blocks_outside_whitelist() -> None:
    assert is_tool_allowed("exec", {"read_file"}) is False
    assert is_tool_allowed("read_file", {"read_file"}) is True


def test_system_prompt_includes_persona_and_bootstrap(tmp_path: Path) -> None:
    store = _store(tmp_path)
    profile = AgentProfile(
        id="speaker",
        name="Speaker",
        description="Talkative agent",
        system_prompt="Always greet the user.",
    )
    store.save(profile)
    store.write_bootstrap("speaker", "soul", "# Speaker soul")
    resolved = resolve_profile(
        profile,
        base_defaults=AgentDefaults(),
        base_tools=ToolsConfig(),
        workspace=tmp_path,
    )
    prompt = build_profile_system_prompt(
        resolved, workspace=tmp_path, channel="cli", chat_id="direct"
    )
    assert "Persona — Speaker" in prompt
    assert "Talkative agent" in prompt
    assert "Speaker soul" in prompt
    assert "Always greet the user." in prompt


def test_list_profiles_returns_all(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.save(AgentProfile(id="a", name="A"))
    store.save(AgentProfile(id="b", name="B"))
    ids = sorted(p.id for p in store.list_profiles())
    assert ids == ["a", "b"]


@pytest.mark.parametrize("bad_id", ["", "..", "a/b", "x/.."])
def test_invalid_profile_id_rejected(tmp_path: Path, bad_id: str) -> None:
    store = _store(tmp_path)
    if not bad_id:
        # Empty string is the "no profile" signal — load returns None.
        assert store.load(bad_id) is None
        return
    profile = AgentProfile(id=bad_id, name="X")
    with pytest.raises(ValueError):
        store.save(profile)
