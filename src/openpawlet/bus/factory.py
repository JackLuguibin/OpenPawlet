"""Thin factory shim: construct the in-process :class:`~openpawlet.bus.queue.MessageBus`.

Older call sites passed broker-related keyword arguments; they are ignored.
"""

from __future__ import annotations

from typing import Any

from openpawlet.bus import queue as _bus_queue
from openpawlet.bus.queue import MessageBusProtocol


def build_message_bus(
    *,
    role: str = "full",  # noqa: ARG001 - kept for backwards compatibility
    subscription: str = "",  # noqa: ARG001
    force_in_process: bool = False,  # noqa: ARG001
    agent_id: str = "",  # noqa: ARG001
    agent_name: str = "",  # noqa: ARG001
    **_legacy: Any,
) -> MessageBusProtocol:
    """Return the in-process :class:`MessageBus` instance.

    All keyword arguments are accepted for backwards compatibility but
    are intentionally ignored: the consolidated console always shares a
    single in-process bus across producers and consumers.
    """
    message_bus_cls = _bus_queue.MessageBus
    return message_bus_cls()
