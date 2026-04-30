"""Exceptions for non-recoverable tool policy failures."""

from __future__ import annotations


class AgentToolAbort(BaseException):
    """Policy violation (e.g. path outside allowed workspace); stop the agent loop for this turn.

    Subclasses :class:`BaseException` (not :class:`Exception`) so ordinary
    ``except Exception`` handlers in tools and helpers cannot swallow this
    signal—it must propagate to :class:`~openpawlet.agent.runner.AgentRunner`.

    It is always treated as a fatal tool error in the runner regardless of
    ``fail_on_tool_error``.
    """
