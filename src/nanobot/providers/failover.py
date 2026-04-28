"""Multi-key / multi-instance fail-over wrapper around :class:`LLMProvider`.

Two layers of resilience:

1. **Intra-instance key rotation** — when a provider instance has multiple
   ``api_keys``, the active key index rotates on triggering errors so the
   next attempt uses a different key.

2. **Inter-instance fail-over** — when the configured triggers (timeout /
   connection / 5xx / 429) fire enough times in a row, the wrapper hands
   off to the next instance in the ``failover_instance_ids`` chain.

The wrapper preserves :class:`LLMProvider`'s public surface so callers
(``AgentRunner`` / streaming pipelines) remain unaware of the routing.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

from loguru import logger

from nanobot.providers.base import LLMProvider, LLMResponse

if TYPE_CHECKING:
    from nanobot.providers.instances import LLMProviderInstance


_TRIGGER_TIMEOUT_KINDS = frozenset({"timeout"})
_TRIGGER_CONNECTION_KINDS = frozenset({"connection"})


def _matches_trigger(response: LLMResponse, triggers: set[str]) -> bool:
    """Return True when *response* should trigger fail-over per *triggers*."""
    if response.finish_reason != "error":
        return False
    kind = (response.error_kind or "").strip().lower()
    if "timeout" in triggers and kind in _TRIGGER_TIMEOUT_KINDS:
        return True
    if "connection" in triggers and kind in _TRIGGER_CONNECTION_KINDS:
        return True
    status = response.error_status_code
    if status is not None:
        if "rate_limit" in triggers and status == 429:
            return True
        if "server_5xx" in triggers and status >= 500:
            return True
    text = (response.content or "").lower()
    if "timeout" in triggers and ("timeout" in text or "timed out" in text):
        return True
    if "connection" in triggers and "connection" in text:
        return True
    if "rate_limit" in triggers and ("rate limit" in text or "429" in text):
        return True
    if "server_5xx" in triggers and any(s in text for s in ("500", "502", "503", "504")):
        return True
    return False


class MultiInstanceFailoverProvider(LLMProvider):
    """Wrap one or more concrete providers with key + instance fail-over.

    The wrapper itself is *not* an HTTP client; it delegates to inner
    providers built by :func:`build_provider_for_instance`.  Each inner
    provider is created lazily so unused fail-over targets don't open
    HTTP clients up-front.
    """

    # Switch fast on transient errors — the inner provider already retried
    # `_CHAT_RETRY_DELAYS` times before bubbling up, so one more attempt
    # against a fresh key/instance is usually enough.
    _MAX_INSTANCE_HOPS = 6

    def __init__(
        self,
        *,
        primary_id: str,
        instance_provider_factory: Callable[[str], LLMProvider | None],
        instance_lookup: Callable[[str], "LLMProviderInstance | None"],
    ) -> None:
        super().__init__(api_key=None, api_base=None)
        self._primary_id = primary_id
        self._factory = instance_provider_factory
        self._lookup = instance_lookup
        self._cache: dict[str, LLMProvider] = {}

    # -- LLMProvider abstract surface --------------------------------------

    def get_default_model(self) -> str:
        provider = self._get_provider(self._primary_id)
        if provider is None:
            return ""
        return provider.get_default_model()

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
        return await self._dispatch(
            "chat",
            messages=messages,
            tools=tools,
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            tool_choice=tool_choice,
        )

    async def chat_stream(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        model: str | None = None,
        max_tokens: int = 4096,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        tool_choice: str | dict[str, Any] | None = None,
        on_content_delta: Callable[[str], Awaitable[None]] | None = None,
    ) -> LLMResponse:
        return await self._dispatch(
            "chat_stream",
            messages=messages,
            tools=tools,
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            tool_choice=tool_choice,
            on_content_delta=on_content_delta,
        )

    # -- Routing -----------------------------------------------------------

    def _get_provider(self, instance_id: str) -> LLMProvider | None:
        if instance_id in self._cache:
            return self._cache[instance_id]
        provider = self._factory(instance_id)
        if provider is None:
            return None
        # Inherit our generation settings so per-call defaults stay consistent
        # across the chain (callers may have set our generation post-init).
        provider.generation = self.generation
        # Forward the token usage recorder so accounting is centralised.
        if self._token_usage_recorder is not None:
            provider._token_usage_recorder = self._token_usage_recorder
        self._cache[instance_id] = provider
        return provider

    def _failover_chain(self, instance_id: str) -> list[str]:
        seen: set[str] = set()
        chain: list[str] = []
        current = instance_id
        depth = 0
        while current and current not in seen and depth < self._MAX_INSTANCE_HOPS:
            seen.add(current)
            chain.append(current)
            inst = self._lookup(current)
            if inst is None or not inst.failover_instance_ids:
                break
            current = inst.failover_instance_ids[0]
            depth += 1
        return chain

    async def _dispatch(self, method: str, **kwargs: Any) -> LLMResponse:
        chain = self._failover_chain(self._primary_id)
        if not chain:
            return LLMResponse(
                content=f"No LLM provider instance available (primary={self._primary_id!r})",
                finish_reason="error",
                error_kind="connection",
            )
        last: LLMResponse | None = None
        for idx, instance_id in enumerate(chain):
            provider = self._get_provider(instance_id)
            if provider is None:
                continue
            inst = self._lookup(instance_id)
            triggers = set(inst.failover_on) if inst else set()
            try:
                fn = getattr(provider, method)
                response: LLMResponse = await fn(**kwargs)
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning(
                    "[failover] provider {} raised: {}", instance_id, exc
                )
                response = LLMResponse(
                    content=f"Provider {instance_id} crashed: {exc}",
                    finish_reason="error",
                    error_kind="connection",
                )
            last = response
            if not _matches_trigger(response, triggers):
                return response
            if idx + 1 < len(chain):
                logger.warning(
                    "[failover] {} failed (kind={}, status={}); switching to {}",
                    instance_id,
                    response.error_kind,
                    response.error_status_code,
                    chain[idx + 1],
                )
                continue
        return last or LLMResponse(
            content="All provider instances failed",
            finish_reason="error",
            error_kind="connection",
        )


class KeyRotatingProvider(LLMProvider):
    """Round-robin wrapper that swaps ``api_key`` between attempts.

    Sits between :class:`MultiInstanceFailoverProvider` and the real
    provider when an instance has multiple keys.  Each call gets the
    current key, and trigger errors rotate to the next one before the
    next attempt.
    """

    def __init__(
        self,
        *,
        inner: LLMProvider,
        api_keys: list[str],
        triggers: set[str],
    ) -> None:
        super().__init__(api_key=inner.api_key, api_base=inner.api_base)
        self._inner = inner
        self._keys = [k for k in api_keys if k]
        self._triggers = triggers
        self._idx = 0
        self.generation = inner.generation
        # Mirror token-usage recorder onto the inner provider when set
        # later via ``attach_token_usage_jsonl``.
        if inner._token_usage_recorder is not None:
            self._token_usage_recorder = inner._token_usage_recorder

    def get_default_model(self) -> str:
        return self._inner.get_default_model()

    def _swap_key(self) -> None:
        if len(self._keys) <= 1:
            return
        self._idx = (self._idx + 1) % len(self._keys)
        self._inner.api_key = self._keys[self._idx]

    async def chat(self, **kwargs: Any) -> LLMResponse:  # type: ignore[override]
        return await self._with_rotation(self._inner.chat, kwargs)

    async def chat_stream(self, **kwargs: Any) -> LLMResponse:  # type: ignore[override]
        return await self._with_rotation(self._inner.chat_stream, kwargs)

    async def _with_rotation(
        self, fn: Callable[..., Awaitable[LLMResponse]], kwargs: dict[str, Any]
    ) -> LLMResponse:
        if not self._keys:
            return await fn(**kwargs)
        # Use current key.
        self._inner.api_key = self._keys[self._idx]
        response = await fn(**kwargs)
        if _matches_trigger(response, self._triggers):
            self._swap_key()
        return response


__all__ = [
    "KeyRotatingProvider",
    "MultiInstanceFailoverProvider",
]
