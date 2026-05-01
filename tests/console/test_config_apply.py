"""Tests for ``console.server.config_apply``.

HTTP handlers persist workspace files; :func:`apply_config_change` schedules
an in-process restart (skipped under pytest via :func:`schedule_console_process_restart`).
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
)
from openpawlet.config.schema import Config  # noqa: E402


def _default_dict() -> dict:
    return Config().model_dump(mode="json", by_alias=True)


@pytest.mark.asyncio
async def test_apply_config_change_triggers_restart_schedule(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_app = SimpleNamespace(state=SimpleNamespace(embedded=None, active_bot_id="default"))

    mock = MagicMock()

    monkeypatch.setattr("console.server.config_apply.schedule_console_process_restart", mock)

    base = _default_dict()
    new = _default_dict()
    new["agents"]["defaults"]["model"] = "openai/gpt-test"

    result = await apply_config_change(fake_app, "default", base, new)
    assert result["mode"] == "reload"
    assert result["ok"] is True
    mock.assert_called_once_with(reason="config.json:default")


@pytest.mark.asyncio
async def test_apply_config_change_restart_on_channels_patch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_app = SimpleNamespace(state=SimpleNamespace(embedded=None, active_bot_id="default"))
    mock = MagicMock()
    monkeypatch.setattr("console.server.config_apply.schedule_console_process_restart", mock)

    base = _default_dict()
    new = _default_dict()
    new.setdefault("channels", {})["telegram"] = {"enabled": True, "token": "x"}

    result = await apply_config_change(fake_app, "default", base, new)
    assert result["mode"] == "reload"
    assert result["ok"] is True
    mock.assert_called_once_with(reason="config.json:default")


@pytest.mark.asyncio
async def test_apply_config_change_schedules_restart_when_config_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Save still triggers a cold boot when merged JSON matches the pre-save snapshot."""
    mock = MagicMock()
    monkeypatch.setattr("console.server.config_apply.schedule_console_process_restart", mock)

    fake_app = SimpleNamespace(state=SimpleNamespace(embedded=None, active_bot_id="default"))
    base = _default_dict()
    result = await apply_config_change(fake_app, "default", base, base)
    assert result["mode"] == "reload"
    mock.assert_called_once_with(reason="config.json:default")


@pytest.mark.asyncio
async def test_apply_config_change_restart_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_app = SimpleNamespace(state=SimpleNamespace(embedded=None, active_bot_id="default"))

    def _boom(**_: object) -> None:
        raise RuntimeError("schedule failed")

    monkeypatch.setattr("console.server.config_apply.schedule_console_process_restart", _boom)

    base = _default_dict()
    new = _default_dict()
    new["agents"]["defaults"]["model"] = "openai/gpt-test"

    result = await apply_config_change(fake_app, "default", base, new)
    assert result["mode"] == "reload"
    assert result["ok"] is False


# ---------------------------------------------------------------------------
# .env → restart schedule
# ---------------------------------------------------------------------------


@pytest.fixture
def _fake_app_with_restart(monkeypatch: pytest.MonkeyPatch):
    fake_app = SimpleNamespace(state=SimpleNamespace(embedded=None, active_bot_id="default"))
    restart_calls = {"n": 0, "reasons": []}

    def _track(**kw: object) -> None:
        restart_calls["n"] += 1
        restart_calls["reasons"].append(kw.get("reason"))

    monkeypatch.setattr("console.server.config_apply.schedule_console_process_restart", _track)
    return fake_app, restart_calls


@pytest.mark.asyncio
async def test_apply_env_change_adds_keys_to_environ(
    monkeypatch: pytest.MonkeyPatch, _fake_app_with_restart
) -> None:
    fake_app, restart_calls = _fake_app_with_restart
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
    assert restart_calls["n"] == 1
    assert restart_calls["reasons"] == [".env:default"]
    monkeypatch.delenv("OP_TEST_NEW_KEY", raising=False)


@pytest.mark.asyncio
async def test_apply_env_change_updates_keys_in_environ(
    monkeypatch: pytest.MonkeyPatch, _fake_app_with_restart
) -> None:
    fake_app, _restart_calls = _fake_app_with_restart
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
    monkeypatch: pytest.MonkeyPatch, _fake_app_with_restart
) -> None:
    fake_app, _restart_calls = _fake_app_with_restart
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
async def test_apply_env_change_noop_skips_restart(
    monkeypatch: pytest.MonkeyPatch, _fake_app_with_restart
) -> None:
    fake_app, restart_calls = _fake_app_with_restart

    same = {"OP_TEST_NOOP_KEY": "v"}
    monkeypatch.setenv("OP_TEST_NOOP_KEY", "v")

    result = await apply_env_change(fake_app, "default", same, dict(same))

    assert restart_calls["n"] == 0
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
    _fake_app_with_restart,
    tmp_path,
) -> None:
    fake_app, restart_calls = _fake_app_with_restart

    config_path = tmp_path / "config.json"
    monkeypatch.setattr(
        "console.server.openpawlet_user_config.resolve_config_path",
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
    assert restart_calls["n"] == 1

    import json

    persisted = json.loads(config_path.read_text(encoding="utf-8"))
    assert persisted["tools"]["exec"]["allowedEnvKeys"] == ["OP_TEST_EXEC_KEY"]
    monkeypatch.delenv("OP_TEST_EXEC_KEY", raising=False)


@pytest.mark.asyncio
async def test_apply_env_change_skips_unknown_exec_keys(
    monkeypatch: pytest.MonkeyPatch,
    _fake_app_with_restart,
    tmp_path,
) -> None:
    fake_app, _restart_calls = _fake_app_with_restart

    config_path = tmp_path / "config.json"
    monkeypatch.setattr(
        "console.server.openpawlet_user_config.resolve_config_path",
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
