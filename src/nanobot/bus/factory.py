"""Bus factory.

Historically this module would dispatch between an in-process
:class:`~nanobot.bus.queue.MessageBus` and a ZeroMQ-backed broker based
on the ``QUEUE_MANAGER_ENABLED`` environment flag.  In the consolidated
single-process layout the broker is gone and the in-process bus is the
only supported option, so this module now collapses to a thin shim that
preserves the legacy signature while ignoring the deprecated knobs.
"""

from __future__ import annotations

from typing import Any

from nanobot.bus import queue as _bus_queue
from nanobot.bus.queue import MessageBusProtocol


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
