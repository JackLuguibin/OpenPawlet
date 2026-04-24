"""Unit tests for the AgentEvent dataclass + envelope encoding."""

from __future__ import annotations

import json

from nanobot.bus.envelope import (
    KEY_KIND,
    KEY_PAYLOAD,
    KEY_SOURCE_AGENT,
    KEY_TARGET,
    KEY_TOPIC,
    KIND_EVENT,
    TARGET_BROADCAST,
    target_for_agent,
    target_for_topic,
)
from nanobot.bus.events import AgentEvent
from nanobot.bus.zmq_bus import (
    _decode_event,
    _encode_event,
    event_zmq_subscriptions,
)


def test_agent_event_defaults_are_populated() -> None:
    ev = AgentEvent(topic="chat.new", payload={"x": 1})
    assert ev.message_id.startswith("m-")
    assert ev.trace_id.startswith("t-")
    assert ev.target == TARGET_BROADCAST
    assert ev.source_agent == "system"
    assert ev.produced_at > 0


def test_agent_event_equality_ignores_envelope_fields() -> None:
    a = AgentEvent(topic="t", payload={"k": 1}, source_agent="alice", target="broadcast")
    b = AgentEvent(topic="t", payload={"k": 1}, source_agent="alice", target="broadcast")
    # Explicit message/trace ids differ, but compare=False keeps them out.
    assert a == b


def test_encode_decode_roundtrip_preserves_fields() -> None:
    ev = AgentEvent(
        topic="inventory.updated",
        payload={"sku": "abc", "delta": -3},
        source_agent="alice",
        target=target_for_topic("inventory"),
        event_seq=17,
    )
    raw = _encode_event(ev)
    decoded = _decode_event(raw)
    assert decoded == ev
    assert decoded.event_seq == 17
    # Envelope kind is set in the JSON so the broker can route it.
    env = json.loads(raw.decode("utf-8"))
    assert env[KEY_KIND] == KIND_EVENT
    assert env[KEY_TOPIC] == "inventory.updated"
    assert env[KEY_SOURCE_AGENT] == "alice"
    assert env[KEY_TARGET] == "topic:inventory"
    assert env[KEY_PAYLOAD] == {"sku": "abc", "delta": -3}


def test_event_zmq_subscriptions_includes_agent_and_broadcast() -> None:
    prefixes = event_zmq_subscriptions(agent_id="bob", topics=("chat", "inventory.updated"))
    assert target_for_agent("bob") in prefixes
    assert TARGET_BROADCAST in prefixes
    assert target_for_topic("chat") in prefixes
    assert target_for_topic("inventory.updated") in prefixes


def test_event_zmq_subscriptions_can_exclude_broadcast() -> None:
    prefixes = event_zmq_subscriptions(
        agent_id="bob", topics=(), include_broadcast=False
    )
    assert TARGET_BROADCAST not in prefixes
    assert target_for_agent("bob") in prefixes
