"""Tests for the multi-instance ``BotsRegistry``.

These tests run the registry against a temporary HOME so they never
touch the real ``~/.openpawlet/`` tree on the developer's machine.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from console.server.bots_registry import (  # noqa: E402
    DEFAULT_BOT_ID,
    BotsRegistry,
)


@pytest.fixture(autouse=True)
def isolated_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Redirect ``Path.home()`` so no test touches the real config dir."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    return tmp_path


def _registry(home: Path) -> BotsRegistry:
    return BotsRegistry(root=home / ".openpawlet")


def test_default_bot_is_seeded(isolated_home: Path) -> None:
    rows = _registry(isolated_home).list()
    assert any(r["id"] == DEFAULT_BOT_ID for r in rows)


def test_add_creates_per_bot_layout(isolated_home: Path) -> None:
    reg = _registry(isolated_home)
    row = reg.add(name="alpha")
    assert row["name"] == "alpha"
    cfg = Path(row["config_path"])
    ws = Path(row["workspace_path"])
    assert cfg.is_file()
    assert ws.is_dir()
    raw = json.loads(cfg.read_text(encoding="utf-8"))
    assert raw["workspace"] == str(ws.resolve())


def test_remove_default_is_rejected(isolated_home: Path) -> None:
    reg = _registry(isolated_home)
    with pytest.raises(ValueError):
        reg.remove(DEFAULT_BOT_ID)


def test_remove_nonexistent_returns_false(isolated_home: Path) -> None:
    reg = _registry(isolated_home)
    assert reg.remove("does-not-exist") is False


def test_set_default_unknown_returns_false(isolated_home: Path) -> None:
    reg = _registry(isolated_home)
    assert reg.set_default("nope") is False


def test_resolve_config_path_falls_back_to_legacy(isolated_home: Path) -> None:
    reg = _registry(isolated_home)
    expected = isolated_home / ".openpawlet" / "config.json"
    assert reg.resolve_config_path(None) == expected
    assert reg.resolve_config_path(DEFAULT_BOT_ID) == expected


def test_resolve_config_path_for_added_bot(isolated_home: Path) -> None:
    reg = _registry(isolated_home)
    row = reg.add(name="beta")
    assert reg.resolve_config_path(str(row["id"])) == Path(row["config_path"])
