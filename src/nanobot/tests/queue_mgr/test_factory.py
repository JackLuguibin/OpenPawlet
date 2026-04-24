"""Bus factory behaviour: honour env flag, fall back gracefully."""

from __future__ import annotations

import pytest


def test_factory_returns_in_process_bus_when_disabled(monkeypatch) -> None:
    from nanobot.bus.factory import build_message_bus
    from nanobot.bus.queue import MessageBus

    monkeypatch.setenv("QUEUE_MANAGER_ENABLED", "false")
    bus = build_message_bus()
    assert isinstance(bus, MessageBus)


def test_factory_defaults_to_in_process_bus(monkeypatch) -> None:
    from nanobot.bus.factory import build_message_bus
    from nanobot.bus.queue import MessageBus

    monkeypatch.delenv("QUEUE_MANAGER_ENABLED", raising=False)
    bus = build_message_bus()
    assert isinstance(bus, MessageBus)


def test_factory_forces_in_process_on_request(monkeypatch) -> None:
    from nanobot.bus.factory import build_message_bus
    from nanobot.bus.queue import MessageBus

    monkeypatch.setenv("QUEUE_MANAGER_ENABLED", "true")
    bus = build_message_bus(force_in_process=True)
    assert isinstance(bus, MessageBus)


def test_factory_builds_zmq_bus_when_enabled(monkeypatch) -> None:
    pytest.importorskip("zmq")
    from nanobot.bus.factory import build_message_bus
    from nanobot.bus.zmq_bus import ZmqMessageBus

    monkeypatch.setenv("QUEUE_MANAGER_ENABLED", "true")
    bus = build_message_bus(role="producer")
    assert isinstance(bus, ZmqMessageBus)
