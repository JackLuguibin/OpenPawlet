"""Tests for ``AgentLoop.apply_hot_config`` and ``replace_provider``.

These pin the contract of "edit config in the SPA, see the change on the
next turn without a restart".  We deliberately do not exercise the heavy
runtime here — only that the field assignments are propagated to the
collaborators (consolidator / dream / sessions / context / auto_compact /
subagents).
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from openpawlet.config.schema import Config


def _make_loop():
    """Create a minimal AgentLoop with mocked dependencies (mirrors test_restart_command)."""
    from openpawlet.agent.loop import AgentLoop
    from openpawlet.bus.queue import MessageBus

    bus = MessageBus()
    provider = MagicMock()
    provider.get_default_model.return_value = "test-model"
    workspace = MagicMock()
    workspace.__truediv__ = MagicMock(return_value=MagicMock())

    with (
        patch("openpawlet.agent.loop.ContextBuilder"),
        patch("openpawlet.agent.loop.SessionManager"),
        patch("openpawlet.agent.loop.SubagentManager"),
    ):
        loop = AgentLoop(bus=bus, provider=provider, workspace=workspace)
    return loop


def _config_with(**defaults_overrides) -> Config:
    """Build a Config whose ``agents.defaults`` carries the given overrides."""
    cfg = Config()
    for key, value in defaults_overrides.items():
        setattr(cfg.agents.defaults, key, value)
    return cfg


def test_apply_hot_config_changes_model_everywhere():
    loop = _make_loop()
    new_cfg = _config_with(model="openai/gpt-test")

    changed = loop.apply_hot_config(new_cfg)

    assert "model" in changed
    assert loop.model == "openai/gpt-test"
    assert loop.consolidator.model == "openai/gpt-test"
    assert loop.dream.model == "openai/gpt-test"


def test_apply_hot_config_changes_timezone_chain():
    loop = _make_loop()
    new_cfg = _config_with(timezone="Asia/Shanghai")

    changed = loop.apply_hot_config(new_cfg)

    assert changed.get("timezone") is not None
    assert loop.timezone == "Asia/Shanghai"
    loop.sessions.configure_timezone.assert_called_with("Asia/Shanghai")


def test_apply_hot_config_changes_max_iterations():
    loop = _make_loop()
    new_cfg = _config_with(max_tool_iterations=42)

    changed = loop.apply_hot_config(new_cfg)

    assert changed.get("max_iterations") is not None
    assert loop.max_iterations == 42


def test_apply_hot_config_changes_max_history_messages():
    loop = _make_loop()
    assert loop.max_history_messages == 0
    new_cfg = _config_with(max_history_messages=80)

    changed = loop.apply_hot_config(new_cfg)

    assert changed.get("max_history_messages") is not None
    assert loop.max_history_messages == 80


def test_apply_hot_config_noop_when_identical():
    loop = _make_loop()
    new_cfg = _config_with(model=loop.model, timezone=loop.timezone)

    changed = loop.apply_hot_config(new_cfg)

    assert changed == {}


def test_apply_hot_config_changes_session_ttl():
    loop = _make_loop()
    new_cfg = _config_with(session_ttl_minutes=30)

    changed = loop.apply_hot_config(new_cfg)

    assert changed.get("session_ttl_minutes") == 30
    assert loop.auto_compact._ttl == 30


def test_replace_provider_propagates_to_collaborators():
    loop = _make_loop()
    new_provider = MagicMock(name="new-provider")

    loop.replace_provider(new_provider)

    assert loop.provider is new_provider
    assert loop.runner.provider is new_provider
    assert loop.consolidator.provider is new_provider
    assert loop.dream.provider is new_provider
