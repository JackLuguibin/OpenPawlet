"""Tests for the startup config auto-fill helpers.

These pin two important behaviours:

* Missing OpenPawlet/server schema fields are filled in from defaults so users
  on freshly-upgraded builds get new options without hand-editing files.
* The auto-fill is a no-op when the file is already up to date — repeated
  startups must not bump the file's mtime, which would otherwise invalidate
  the ``build_config_response`` mtime cache on every boot.
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

from console.server.config.loader import ensure_server_config  # noqa: E402
from console.server.openpawlet_user_config import ensure_full_config  # noqa: E402


def test_ensure_full_config_noop_when_file_missing(tmp_path: Path) -> None:
    """No file -> no creation; this matches the opt-in policy."""
    target = tmp_path / "config.json"
    assert ensure_full_config(target) is False
    assert not target.exists()


def test_ensure_full_config_fills_missing_fields(tmp_path: Path) -> None:
    """Sparse user files gain every default field while preserving overrides."""
    target = tmp_path / "config.json"
    target.write_text(
        json.dumps(
            {
                "agents": {"defaults": {"model": "openai/gpt-test"}},
                "skills": {"my_skill": {"path": "x"}},
            }
        ),
        encoding="utf-8",
    )

    assert ensure_full_config(target) is True

    data = json.loads(target.read_text(encoding="utf-8"))
    # User override survived auto-fill.
    assert data["agents"]["defaults"]["model"] == "openai/gpt-test"
    # New defaults were materialised — pick a few stable schema fields.
    assert "temperature" in data["agents"]["defaults"]
    assert "providers" in data
    assert "tools" in data
    # Top-level extras (e.g. ``skills``) are kept verbatim.
    assert data["skills"] == {"my_skill": {"path": "x"}}


def test_ensure_full_config_is_idempotent(tmp_path: Path) -> None:
    """A second call right after the first must not rewrite the file."""
    target = tmp_path / "config.json"
    target.write_text(json.dumps({"agents": {"defaults": {"model": "m"}}}), encoding="utf-8")

    assert ensure_full_config(target) is True
    mtime_after_first = target.stat().st_mtime_ns

    assert ensure_full_config(target) is False
    assert target.stat().st_mtime_ns == mtime_after_first


def test_ensure_full_config_skips_invalid_files(tmp_path: Path) -> None:
    """Validation errors must not nuke the user's file."""
    target = tmp_path / "config.json"
    target.write_text(
        json.dumps(
            {
                "agents": {"defaults": {"maxTokens": "not-a-number"}},
            }
        ),
        encoding="utf-8",
    )
    original = target.read_text(encoding="utf-8")

    assert ensure_full_config(target) is False
    # File untouched so the surrounding loader can surface the original error.
    assert target.read_text(encoding="utf-8") == original


def test_ensure_server_config_noop_when_file_missing(tmp_path: Path) -> None:
    """openpawlet_web.json is opt-in; auto-fill never creates it."""
    target = tmp_path / "openpawlet_web.json"
    assert ensure_server_config(target) is False
    assert not target.exists()


def test_ensure_server_config_fills_missing_fields(tmp_path: Path) -> None:
    """A sparse server section gains every defaulted field."""
    target = tmp_path / "openpawlet_web.json"
    target.write_text(
        json.dumps({"server": {"port": 9100}, "extra": {"foo": "bar"}}),
        encoding="utf-8",
    )

    assert ensure_server_config(target) is True
    data = json.loads(target.read_text(encoding="utf-8"))
    # User override preserved.
    assert data["server"]["port"] == 9100
    # New defaults present (sample a few stable settings).
    assert data["server"]["host"] == "localhost"
    assert "log_level" in data["server"]
    assert "version" not in data["server"]
    # Unknown top-level keys preserved.
    assert data["extra"] == {"foo": "bar"}


def test_ensure_server_config_strips_legacy_version(tmp_path: Path) -> None:
    target = tmp_path / "openpawlet_web.json"
    target.write_text(
        json.dumps({"server": {"port": 9100, "version": "0.0.0-stale"}}),
        encoding="utf-8",
    )

    assert ensure_server_config(target) is True
    data = json.loads(target.read_text(encoding="utf-8"))
    assert data["server"]["port"] == 9100
    assert "version" not in data["server"]


def test_ensure_server_config_is_idempotent(tmp_path: Path) -> None:
    target = tmp_path / "openpawlet_web.json"
    target.write_text(json.dumps({"server": {"port": 9100}}), encoding="utf-8")

    assert ensure_server_config(target) is True
    mtime_after_first = target.stat().st_mtime_ns

    assert ensure_server_config(target) is False
    assert target.stat().st_mtime_ns == mtime_after_first


@pytest.mark.parametrize("payload", ["{not valid json", '"a string"'])
def test_ensure_server_config_skips_unreadable_files(tmp_path: Path, payload: str) -> None:
    """Garbage on disk must not be overwritten silently."""
    target = tmp_path / "openpawlet_web.json"
    target.write_text(payload, encoding="utf-8")

    assert ensure_server_config(target) is False
    assert target.read_text(encoding="utf-8") == payload
