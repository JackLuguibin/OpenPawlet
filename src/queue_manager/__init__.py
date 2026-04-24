"""OpenPawlet centralized ZeroMQ Queue Manager.

This package hosts the broker process that sits between producers
(Console, cron, heartbeat, channels) and consumers (Nanobot agent
workers, channel dispatchers).  It owns:

- ZeroMQ socket topology (PULL ingress / PUB worker fan-out,
  PULL egress / PUB delivery fan-out).
- The idempotency store used to reach business-level "exactly once".
- Observability counters (depth, dedupe hits, drops).
"""

from queue_manager.config import QueueManagerSettings, get_settings
from queue_manager.idempotency import IdempotencyStore
from queue_manager.service import QueueManagerBroker

__all__ = [
    "IdempotencyStore",
    "QueueManagerBroker",
    "QueueManagerSettings",
    "get_settings",
]
