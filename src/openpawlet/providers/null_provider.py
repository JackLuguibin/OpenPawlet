"""Placeholder LLM provider used while the user has not configured one yet.

The console hosts the embedded OpenPawlet runtime alongside the SPA so that
sessions/teams/channels remain inspectable even before any LLM credential
has been entered. Constructing the runtime against a real provider used
to fail with :class:`ProviderNotConfiguredError`, which kept the entire
``app.state.embedded`` graph empty and caused most ``/api/v1`` endpoints to
return 503-style "degraded mode" errors.

:class:`NullProvider` removes that hard dependency: every chat call returns
an ``error`` :class:`LLMResponse` whose content explains that the user must
configure an LLM provider in the console before the agent can serve real
turns. The model name and generation defaults stay valid so the rest of the
runtime (AgentLoop, channels, cron, heartbeat) boots normally.

Once the user adds a provider via ``Settings → Providers``, the console
calls :func:`console.server.config_apply.apply_providers_change` which
swaps this placeholder out for the freshly built real provider via
:meth:`AgentLoop.replace_provider` — no restart required.
"""

from __future__ import annotations

from typing import Any

from openpawlet.providers.base import LLMProvider, LLMResponse

# Sentinel default model. Surfaced via ``get_default_model`` so consumers
# (loop, sub-agents) that capture the model name at construction time
# still get a stable, recognisable string. The agent loop never actually
# sends requests using this name because every chat call short-circuits
# to an error response below.
_PLACEHOLDER_MODEL = "openpawlet/null"

_NOT_CONFIGURED_MESSAGE = (
    "No LLM provider is configured for this workspace. Open the OpenPawlet "
    "console (Settings → Providers) and add at least one provider with a "
    "valid API key. The agent will resume automatically once a provider is "
    "available — no restart required."
)


class NullProvider(LLMProvider):
    """Placeholder provider that fails every chat call with a friendly message."""

    def __init__(self, *, default_model: str = _PLACEHOLDER_MODEL) -> None:
        super().__init__(api_key=None, api_base=None)
        self._default_model = default_model

    def get_default_model(self) -> str:
        return self._default_model

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        model: str | None = None,
        max_tokens: int = 4096,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        tool_choice: str | dict[str, Any] | None = None,
    ) -> LLMResponse:
        # ``finish_reason="error"`` keeps retries/back-off in
        # :meth:`LLMProvider.chat_with_retry` from looping on this
        # response, while ``error_should_retry=False`` makes it explicit
        # that the only way out is a configuration change (handled by
        # ``replace_provider``).
        return LLMResponse(
            content=_NOT_CONFIGURED_MESSAGE,
            finish_reason="error",
            error_kind="not_configured",
            error_should_retry=False,
        )


def is_null_provider(provider: Any) -> bool:
    """Return True when *provider* is a :class:`NullProvider` (or wrapped one).

    The provider may be wrapped in :class:`KeyRotatingProvider` /
    :class:`MultiInstanceFailoverProvider`; we look through the common
    ``inner`` / ``_factory`` slots so callers can ask "do we currently
    have a real LLM behind the agent?" without caring about wrappers.
    """
    if isinstance(provider, NullProvider):
        return True
    inner = getattr(provider, "inner", None)
    if inner is not None and isinstance(inner, NullProvider):
        return True
    return False


__all__ = ["NullProvider", "is_null_provider"]
