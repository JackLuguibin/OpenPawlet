"""Tests for ``console.server.config_apply``.

These pin the routing decision (hot vs swap) and the AgentLoop hot-apply
field-by-field semantics.  The hot-apply plumbing is what lets users edit
``config.json`` from the SPA and observe the change without restarting
the server, so it is worth a focused safety net.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from console.server.config_apply import (  # noqa: E402
    apply_config_change,
    apply_env_change,
    needs_runtime_swap,
)
from nanobot.config.schema import Config  # noqa: E402


def _default_dict() -> dict:
    return Config().model_dump(mode="json", by_alias=True)


def test_needs_swap_false_for_identical_config() -> None:
    base = _default_dict()
    assert needs_runtime_swap(base, base) is False


def test_needs_swap_false_for_hot_only_field_changes() -> None:
    """Only changing model/timezone should not require a runtime rebuild."""
    base = _default_dict()
    new = _default_dict()
    new["agents"]["defaults"]["model"] = "openai/gpt-test"
    new["agents"]["defaults"]["timezone"] = "Asia/Shanghai"
    assert needs_runtime_swap(base, new) is False


def test_needs_swap_true_for_channels_change() -> None:
    base = _default_dict()
    new = _default_dict()
    new.setdefault("channels", {})["telegram"] = {"enabled": True, "token": "x"}
    assert needs_runtime_swap(base, new) is True


def test_needs_swap_true_for_mcp_servers_change() -> None:
    base = _default_dict()
    new = _default_dict()
    tools = new.setdefault("tools", {})
    tools["mcpServers"] = {"my-mcp": {"command": "echo"}}
    assert needs_runtime_swap(base, new) is True


def test_needs_swap_true_for_exec_change() -> None:
    base = _default_dict()
    new = _default_dict()
    tools = new.setdefault("tools", {})
    tools["exec"] = {"enable": False}
    assert needs_runtime_swap(base, new) is True


def test_needs_swap_false_when_only_ssrf_whitelist_changes() -> None:
    """SSRF whitelist is hot-applied via the global helper, not a swap."""
    base = _default_dict()
    new = _default_dict()
    new.setdefault("tools", {}).setdefault("ssrfWhitelist", []).append("example.com")
    assert needs_runtime_swap(base, new) is False


@pytest.mark.asyncio
async def test_apply_config_change_routes_hot_apply(monkeypatch: pytest.MonkeyPatch) -> None:
    """A model-only change must route to hot-apply (no swap_runtime call)."""
    fake_agent = SimpleNamespace(apply_hot_config=MagicMock(return_value={"model": ("a", "b")}))
    fake_embedded = SimpleNamespace(agent=fake_agent)
    fake_app = SimpleNamespace(state=SimpleNamespace(embedded=fake_embedded, active_bot_id="default"))

    swap_called = {"n": 0}

    async def _fake_swap(_app, _bot_id):
        swap_called["n"] += 1
        return True

    monkeypatch.setattr("console.server.lifespan.swap_runtime", _fake_swap)

    base = _default_dict()
    new = _default_dict()
    new["agents"]["defaults"]["model"] = "openai/gpt-test"

    result = await apply_config_change(fake_app, "default", base, new)
    assert result["mode"] == "hot"
    assert swap_called["n"] == 0
    fake_agent.apply_hot_config.assert_called_once()


@pytest.mark.asyncio
async def test_apply_config_change_routes_swap(monkeypatch: pytest.MonkeyPatch) -> None:
    """A channels change must trigger swap_runtime instead of hot apply."""
    fake_agent = SimpleNamespace(apply_hot_config=MagicMock(return_value={}))
    fake_embedded = SimpleNamespace(agent=fake_agent)
    fake_app = SimpleNamespace(state=SimpleNamespace(embedded=fake_embedded, active_bot_id="default"))

    swap_called = {"n": 0}

    async def _fake_swap(_app, _bot_id):
        swap_called["n"] += 1
        return True

    monkeypatch.setattr("console.server.lifespan.swap_runtime", _fake_swap)

    base = _default_dict()
    new = _default_dict()
    new.setdefault("channels", {})["telegram"] = {"enabled": True, "token": "x"}

    result = await apply_config_change(fake_app, "default", base, new)
    assert result["mode"] == "swap"
    assert swap_called["n"] == 1
    fake_agent.apply_hot_config.assert_not_called()


@pytest.mark.asyncio
async def test_apply_config_change_noop(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_app = SimpleNamespace(state=SimpleNamespace(embedded=None, active_bot_id="default"))
    base = _default_dict()
    result = await apply_config_change(fake_app, "default", base, base)
    assert result["mode"] == "noop"


@pytest.mark.asyncio
async def test_apply_config_change_handles_missing_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Hot-apply with no embedded runtime is a graceful no-op."""
    fake_app = SimpleNamespace(state=SimpleNamespace(embedded=None, active_bot_id="default"))
    base = _default_dict()
    new = _default_dict()
    new["agents"]["defaults"]["model"] = "openai/gpt-test"

    result = await apply_config_change(fake_app, "default", base, new)
    assert result["mode"] == "hot"
    assert result["changed"] == {}


# ---------------------------------------------------------------------------
# .env hot-apply
# ---------------------------------------------------------------------------


@pytest.fixture
def _fake_app_with_swap(monkeypatch: pytest.MonkeyPatch):
    """Provide a FastAPI-like app + a counted ``swap_runtime`` stub."""
    fake_app = SimpleNamespace(state=SimpleNamespace(embedded=None, active_bot_id="default"))
    swap_calls = {"n": 0, "bot_ids": []}

    async def _fake_swap(_app, bot_id):
        swap_calls["n"] += 1
        swap_calls["bot_ids"].append(bot_id)
        return True

    monkeypatch.setattr("console.server.lifespan.swap_runtime", _fake_swap)
    return fake_app, swap_calls


@pytest.mark.asyncio
async def test_apply_env_change_adds_keys_to_environ(
    monkeypatch: pytest.MonkeyPatch, _fake_app_with_swap
) -> None:
    fake_app, swap_calls = _fake_app_with_swap
    monkeypatch.delenv("OP_TEST_NEW_KEY", raising=False)

    result = await apply_env_change(
        fake_app, "default", {}, {"OP_TEST_NEW_KEY": "value-1"}
    )

    import os

    assert os.environ["OP_TEST_NEW_KEY"] == "value-1"
    assert result == {
        "added": ["OP_TEST_NEW_KEY"],
        "updated": [],
        "removed": [],
        "exec_allowlist_changed": False,
        "swap_ok": True,
    }
    assert swap_calls["n"] == 1
    monkeypatch.delenv("OP_TEST_NEW_KEY", raising=False)


@pytest.mark.asyncio
async def test_apply_env_change_updates_keys_in_environ(
    monkeypatch: pytest.MonkeyPatch, _fake_app_with_swap
) -> None:
    fake_app, _swap_calls = _fake_app_with_swap
    monkeypatch.setenv("OP_TEST_UPDATE_KEY", "old")

    result = await apply_env_change(
        fake_app,
        "default",
        {"OP_TEST_UPDATE_KEY": "old"},
        {"OP_TEST_UPDATE_KEY": "new"},
    )

    import os

    assert os.environ["OP_TEST_UPDATE_KEY"] == "new"
    assert result["updated"] == ["OP_TEST_UPDATE_KEY"]
    assert result["added"] == []
    assert result["removed"] == []
    monkeypatch.delenv("OP_TEST_UPDATE_KEY", raising=False)


@pytest.mark.asyncio
async def test_apply_env_change_removes_keys_from_environ(
    monkeypatch: pytest.MonkeyPatch, _fake_app_with_swap
) -> None:
    fake_app, _swap_calls = _fake_app_with_swap
    monkeypatch.setenv("OP_TEST_REMOVE_KEY", "stale")

    result = await apply_env_change(
        fake_app, "default", {"OP_TEST_REMOVE_KEY": "stale"}, {}
    )

    import os

    assert "OP_TEST_REMOVE_KEY" not in os.environ
    assert result["removed"] == ["OP_TEST_REMOVE_KEY"]
    assert result["added"] == []
    assert result["updated"] == []


@pytest.mark.asyncio
async def test_apply_env_change_noop_skips_swap(
    monkeypatch: pytest.MonkeyPatch, _fake_app_with_swap
) -> None:
    """Saving the same vars twice should not trigger a runtime rebuild."""
    fake_app, swap_calls = _fake_app_with_swap

    same = {"OP_TEST_NOOP_KEY": "v"}
    monkeypatch.setenv("OP_TEST_NOOP_KEY", "v")

    result = await apply_env_change(fake_app, "default", same, dict(same))

    assert swap_calls["n"] == 0
    assert result == {
        "added": [],
        "updated": [],
        "removed": [],
        "exec_allowlist_changed": False,
        "swap_ok": True,
    }
    monkeypatch.delenv("OP_TEST_NOOP_KEY", raising=False)


@pytest.mark.asyncio
async def test_apply_env_change_syncs_exec_allowlist(
    monkeypatch: pytest.MonkeyPatch,
    _fake_app_with_swap,
    tmp_path,
) -> None:
    """User-toggled exec visibility writes through to tools.exec.allowedEnvKeys."""
    fake_app, swap_calls = _fake_app_with_swap

    config_path = tmp_path / "config.json"
    monkeypatch.setattr(
        "console.server.nanobot_user_config.resolve_config_path",
        lambda _bot_id: config_path,
    )

    monkeypatch.setenv("OP_TEST_EXEC_KEY", "shh")

    result = await apply_env_change(
        fake_app,
        "default",
        {},
        {"OP_TEST_EXEC_KEY": "shh"},
        exec_visible_keys=["OP_TEST_EXEC_KEY"],
    )

    assert result["exec_allowlist_changed"] is True
    assert swap_calls["n"] == 1

    import json

    persisted = json.loads(config_path.read_text(encoding="utf-8"))
    assert persisted["tools"]["exec"]["allowedEnvKeys"] == ["OP_TEST_EXEC_KEY"]
    monkeypatch.delenv("OP_TEST_EXEC_KEY", raising=False)


@pytest.mark.asyncio
async def test_apply_env_change_skips_unknown_exec_keys(
    monkeypatch: pytest.MonkeyPatch,
    _fake_app_with_swap,
    tmp_path,
) -> None:
    """Keys requested for exec but absent from .env are filtered out."""
    fake_app, _swap_calls = _fake_app_with_swap

    config_path = tmp_path / "config.json"
    monkeypatch.setattr(
        "console.server.nanobot_user_config.resolve_config_path",
        lambda _bot_id: config_path,
    )

    monkeypatch.setenv("OP_TEST_REAL_KEY", "v")

    result = await apply_env_change(
        fake_app,
        "default",
        {},
        {"OP_TEST_REAL_KEY": "v"},
        exec_visible_keys=["OP_TEST_REAL_KEY", "OP_TEST_GHOST_KEY"],
    )

    assert result["exec_allowlist_changed"] is True

    import json

    persisted = json.loads(config_path.read_text(encoding="utf-8"))
    assert persisted["tools"]["exec"]["allowedEnvKeys"] == ["OP_TEST_REAL_KEY"]
    monkeypatch.delenv("OP_TEST_REAL_KEY", raising=False)
