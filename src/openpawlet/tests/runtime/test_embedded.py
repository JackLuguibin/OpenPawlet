from __future__ import annotations

from openpawlet.config.schema import Config
from openpawlet.runtime.embedded import EmbeddedOpenPawlet


def test_from_environment_forces_websocket_channel_for_unified_console(
    monkeypatch,
) -> None:
    """from_environment should always enable websocket with proxy-aligned settings."""
    cfg = Config()
    cfg.channels.websocket = {
        "enabled": False,
        "host": "0.0.0.0",
        "port": 9999,
        "path": "/ws",
        "websocket_requires_token": True,
    }

    captured: dict[str, object] = {}

    def _fake_load_runtime_config(config_path=None, workspace=None):
        return cfg

    def _fake_init(self, *, config, verbose=False, provider_factory=None):  # noqa: ANN001
        captured["config"] = config
        captured["verbose"] = verbose

    monkeypatch.setattr("openpawlet.cli.commands._load_runtime_config", _fake_load_runtime_config)
    monkeypatch.setattr(EmbeddedOpenPawlet, "__init__", _fake_init)

    EmbeddedOpenPawlet.from_environment(
        websocket_host="127.0.0.1",
        websocket_port=8765,
        websocket_path="/",
        websocket_requires_token=False,
    )

    loaded_cfg = captured["config"]
    assert isinstance(loaded_cfg, Config)
    ws = loaded_cfg.channels.websocket
    assert isinstance(ws, dict)
    assert ws["enabled"] is True
    assert ws["host"] == "127.0.0.1"
    assert ws["port"] == 8765
    assert ws["path"] == "/"
    assert ws["websocket_requires_token"] is False
