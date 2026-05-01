"""Light smoke tests for the ``console`` CLI surface.

These do not spin up uvicorn or subprocesses; they just exercise the
argparse layer so a regression in the command table is caught quickly.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from console import cli as console_cli


def _call_with_args(argv: list[str]) -> None:
    """Invoke ``console_cli.main`` as if launched from the shell."""
    saved = sys.argv[:]
    try:
        sys.argv = ["console", *argv]
        console_cli.main()
    finally:
        sys.argv = saved


def test_help_lists_all_commands(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exc:
        _call_with_args(["--help"])
    assert exc.value.code == 0
    out = capsys.readouterr().out
    for command in ("server", "start", "init-config", "web"):
        assert command in out, f"missing {command!r} in --help output"


def test_start_help_documents_no_spa_flag(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(SystemExit) as exc:
        _call_with_args(["start", "--help"])
    assert exc.value.code == 0
    out = capsys.readouterr().out
    assert "--no-spa" in out
    # Legacy gateway flags must be gone in the unified single-process layout.
    assert "--no-gateway" not in out
    assert "--strict-gateway" not in out


def test_server_help_documents_no_spa_flag(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(SystemExit) as exc:
        _call_with_args(["server", "--help"])
    assert exc.value.code == 0
    out = capsys.readouterr().out
    assert "--no-spa" in out


def test_init_config_writes_default_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import openpawlet.config.loader as openpawlet_loader

    monkeypatch.setattr(openpawlet_loader, "_current_config_path", tmp_path / "config.json")

    with pytest.raises(SystemExit) as exc:
        _call_with_args(["init-config"])
    assert exc.value.code == 0

    written = tmp_path / "openpawlet_web.json"
    assert written.is_file()
    data = json.loads(written.read_text(encoding="utf-8"))
    assert "server" in data
    assert "port" in data["server"]
    assert "version" not in data["server"]


def test_init_config_refuses_to_overwrite(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import openpawlet.config.loader as openpawlet_loader

    monkeypatch.setattr(openpawlet_loader, "_current_config_path", tmp_path / "config.json")
    target = tmp_path / "openpawlet_web.json"
    target.write_text('{"server": {"port": 1234}}', encoding="utf-8")

    with pytest.raises(SystemExit) as exc:
        _call_with_args(["init-config"])
    assert exc.value.code != 0
    assert json.loads(target.read_text(encoding="utf-8")) == {"server": {"port": 1234}}


def test_init_config_force_overwrites(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import openpawlet.config.loader as openpawlet_loader

    monkeypatch.setattr(openpawlet_loader, "_current_config_path", tmp_path / "config.json")
    target = tmp_path / "openpawlet_web.json"
    target.write_text('{"server": {"port": 1234}}', encoding="utf-8")

    with pytest.raises(SystemExit) as exc:
        _call_with_args(["init-config", "--force"])
    assert exc.value.code == 0
    data = json.loads(target.read_text(encoding="utf-8"))
    assert "server" in data
    # The default file uses the schema defaults, not the leftover port.
    assert data["server"].get("port") == 8000
    assert "version" not in data["server"]
