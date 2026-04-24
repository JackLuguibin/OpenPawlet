"""Queue Manager command-line entry point.

Exposed as ``open-pawlet-queue-manager`` via ``pyproject.toml`` so it
can be launched by honcho, systemd, or any container orchestrator
without going through the console CLI.
"""

from __future__ import annotations

import asyncio
import sys

from loguru import logger

from queue_manager.config import get_settings
from queue_manager.service import QueueManagerBroker


def main() -> None:
    """Run the broker until a termination signal is received."""
    settings = get_settings()
    if not settings.enabled:
        logger.info(
            "QUEUE_MANAGER_ENABLED=false; broker exits immediately. "
            "Producers/consumers will fall back to the in-process bus."
        )
        return
    logger.remove()
    logger.add(sys.stderr, level=settings.log_level.upper())
    broker = QueueManagerBroker(settings)
    logger.info("Starting Queue Manager broker on {}", settings.host)
    try:
        asyncio.run(broker.run_forever())
    except KeyboardInterrupt:  # pragma: no cover - user abort
        logger.info("Queue Manager broker interrupted; exiting.")


if __name__ == "__main__":
    main()
