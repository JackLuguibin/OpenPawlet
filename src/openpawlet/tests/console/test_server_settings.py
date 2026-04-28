"""Regression tests for OpenPawlet console ``ServerSettings`` resolution.

The console resolves settings in this order (highest priority first):

1. ``__init__`` kwargs
2. ``OPENPAWLET_SERVER_*`` environment variables
3. ``.env`` file in the working directory
4. ``~/.openpawlet/openpawlet_web.json`` under the ``server`` key
5. Built-in field defaults

These tests pin that behaviour so future pydantic-settings upgrades or
source-ordering changes cannot silently invert the priority.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from console.server.config import (
    ServerSettings,
    get_settings,
    reset_settings_cache,
)


@pytest.fixture(autouse=True)
def _clear_settings_cache() -> None:
    """Ensure every test starts with a fresh ``get_settings`` cache."""
    reset_settings_cache()
    yield
    reset_settings_cache()


@pytest.fixture
def isolated_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Redirect the OpenPawlet config dir to ``tmp_path`` so tests don't touch ``~``.

    Returns the expected ``openpawlet_web.json`` path.
    """
    import openpawlet.config.loader as openpawlet_loader

    fake_openpawlet_config = tmp_path / "config.json"
    monkeypatch.setattr(openpawlet_loader, "_current_config_path", fake_openpawlet_config)
    # Clear every OPENPAWLET_SERVER_* env var so tests control them explicitly.
    for key in list(__import__("os").environ):
        if key.startswith("OPENPAWLET_SERVER_"):
            monkeypatch.delenv(key, raising=False)
    return tmp_path / "openpawlet_web.json"


def _write_server_json(path: Path, overrides: dict) -> None:
    path.write_text(
        json.dumps({"server": overrides}, indent=2),
        encoding="utf-8",
    )


def test_defaults_when_nothing_is_set(isolated_config: Path) -> None:
    settings = ServerSettings()
    # Default host is loopback so the unauthenticated API is not exposed
    # to the network without an explicit opt-in.
    assert settings.host == "127.0.0.1"
    assert settings.port == 8000
    assert settings.reload is False
    assert settings.effective_docs_url == "/docs"
    assert settings.effective_openapi_url == "/openapi.json"


def test_json_file_overrides_defaults(isolated_config: Path) -> None:
    _write_server_json(isolated_config, {"port": 9100, "host": "127.0.0.1"})
    settings = ServerSettings()
    assert settings.port == 9100
    assert settings.host == "127.0.0.1"


def test_env_overrides_json_file(isolated_config: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write_server_json(isolated_config, {"port": 9100})
    monkeypatch.setenv("OPENPAWLET_SERVER_PORT", "9200")
    settings = ServerSettings()
    assert settings.port == 9200


def test_init_kwargs_override_env(isolated_config: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENPAWLET_SERVER_PORT", "9200")
    settings = ServerSettings(port=9300)
    assert settings.port == 9300


def test_malformed_json_falls_back_to_defaults(
    isolated_config: Path,
) -> None:
    isolated_config.write_text("{not valid json", encoding="utf-8")
    settings = ServerSettings()
    assert settings.port == 8000


def test_empty_docs_url_disables_swagger() -> None:
    settings = ServerSettings(docs_url="", redoc_url="", openapi_url="")
    assert settings.effective_docs_url is None
    assert settings.effective_redoc_url is None
    assert settings.effective_openapi_url is None


def test_docs_enabled_regardless_of_reload() -> None:
    """Docs are on by default; only empty strings turn them off.

    Older versions tied docs visibility to ``reload``, which was confusing.
    This test guards against a regression to that behaviour.
    """
    settings = ServerSettings(reload=True)
    assert settings.effective_docs_url == "/docs"
    assert settings.effective_openapi_url == "/openapi.json"


def test_get_settings_is_cached(isolated_config: Path) -> None:
    first = get_settings()
    second = get_settings()
    assert first is second


def test_reset_settings_cache_picks_up_new_env(
    isolated_config: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = get_settings()
    assert first.port == 8000
    monkeypatch.setenv("OPENPAWLET_SERVER_PORT", "9400")
    reset_settings_cache()
    second = get_settings()
    assert second.port == 9400


def test_get_settings_does_not_write_default_file(
    isolated_config: Path,
) -> None:
    """Reading settings must not create the JSON file on disk."""
    _ = get_settings()
    assert not isolated_config.exists()
