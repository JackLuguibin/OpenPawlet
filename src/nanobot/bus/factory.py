"""Factory that picks the right :class:`MessageBus` implementation at boot.

Two knobs control the selection:

``QUEUE_MANAGER_ENABLED``  master switch, defaults to ``true``.  Disable
    it to keep the original in-process ``MessageBus`` behaviour during
    rollouts or on development boxes without a running broker.
``QUEUE_MANAGER_HOST`` / ``QUEUE_MANAGER_*_PORT``  ZeroMQ endpoints for
    the broker.  The defaults match the broker's own defaults so a
    ``honcho start`` works out of the box.
"""

from __future__ import annotations

import os

from loguru import logger

from nanobot.bus import queue as _bus_queue
from nanobot.bus.queue import MessageBusProtocol
from nanobot.bus.zmq_bus import ZmqBusEndpoints, ZmqMessageBus


def _flag(value: str | None, default: bool) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def build_message_bus(
    *,
    role: str = "full",
    subscription: str = "",
    force_in_process: bool = False,
) -> MessageBusProtocol:
    """Return a bus instance chosen from environment configuration.

    The in-process :class:`MessageBus` is the default so that unit
    tests and ad-hoc scripts keep working without a broker.  Production
    deployments opt into the ZeroMQ path by setting
    ``QUEUE_MANAGER_ENABLED=true`` - the ``open-pawlet start`` CLI and
    the Procfile both do this automatically.

    Args:
        role: ZmqMessageBus role (``full`` / ``producer`` / ``agent`` /
            ``dispatcher``).  Ignored when falling back to in-process.
        subscription: Optional ZeroMQ subscription prefix.  Usually
            empty so every consumer receives every frame.
        force_in_process: If True, skip the queue manager even when it
            is enabled.  Handy for CLI helpers that never talk to the
            broker (``nanobot agent -m "..."``).
    """
    # Resolve ``MessageBus`` lazily via the module so monkeypatching
    # ``nanobot.bus.queue.MessageBus`` in tests keeps working.
    message_bus_cls = _bus_queue.MessageBus
    if force_in_process:
        return message_bus_cls()
    if not _flag(os.environ.get("QUEUE_MANAGER_ENABLED"), default=False):
        return message_bus_cls()
    try:
        host = os.environ.get("QUEUE_MANAGER_HOST", "127.0.0.1")
        base_port = int(os.environ.get("QUEUE_MANAGER_INGRESS_PORT", "7180"))
        endpoints = ZmqBusEndpoints(
            ingress=f"tcp://{host}:{base_port}",
            worker=f"tcp://{host}:{os.environ.get('QUEUE_MANAGER_WORKER_PORT', base_port + 1)}",
            egress=f"tcp://{host}:{os.environ.get('QUEUE_MANAGER_EGRESS_PORT', base_port + 2)}",
            delivery=f"tcp://{host}:{os.environ.get('QUEUE_MANAGER_DELIVERY_PORT', base_port + 3)}",
        )
        return ZmqMessageBus(endpoints, role=role, subscription=subscription)
    except Exception as exc:  # pragma: no cover - surfaced only on import errors
        logger.warning(
            "Could not build ZmqMessageBus ({}); falling back to in-process.",
            exc,
        )
        return message_bus_cls()
