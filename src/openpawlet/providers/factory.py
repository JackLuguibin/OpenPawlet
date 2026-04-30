"""Single source of truth for building an :class:`LLMProvider` from a ``Config``.

Both the CLI and the SDK previously duplicated the routing/validation logic for
choosing a provider backend.  This module centralizes that logic so callers only
need to decide *how* to surface configuration errors (raise an exception, print
an error in a CLI, etc.) via the ``error_handler`` callable.

Two construction paths coexist:

* :func:`build_provider` — legacy path that derives the provider from
  ``agents.defaults.model`` plus the per-provider single-instance
  :class:`~openpawlet.config.schema.ProvidersConfig` block.

* :func:`build_provider_for_instance` — picks one
  :class:`~openpawlet.providers.instances.LLMProviderInstance` (by id) and
  wraps it in :class:`KeyRotatingProvider` / :class:`MultiInstanceFailoverProvider`
  so multi-key + multi-instance fail-over works transparently.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Any, NoReturn

from openpawlet.providers.base import GenerationSettings, LLMProvider
from openpawlet.providers.failover import KeyRotatingProvider, MultiInstanceFailoverProvider
from openpawlet.providers.instances import LLMProviderInstance, LLMProviderStore
from openpawlet.providers.registry import find_by_name

if TYPE_CHECKING:
    from openpawlet.config.schema import Config


def _default_error_handler(message: str) -> NoReturn:
    """Default error handler: raise a ``ValueError`` with ``message``."""
    raise ValueError(message)


def _validate_provider_credentials(
    *,
    backend: str,
    model: str,
    provider_cfg: Any,
    spec: Any,
    error: Callable[[str], NoReturn],
) -> None:
    """Validate that the chosen backend has the credentials it needs."""
    if backend == "azure_openai":
        if not provider_cfg or not provider_cfg.api_key or not provider_cfg.api_base:
            error("Azure OpenAI requires api_key and api_base in config.")
    elif backend == "openai_compat" and not model.startswith("bedrock/"):
        needs_key = not (provider_cfg and provider_cfg.api_key)
        exempt = spec and (spec.is_oauth or spec.is_local or spec.is_direct)
        if needs_key and not exempt:
            provider_name = getattr(spec, "name", None) or "<unknown>"
            error(f"No API key configured for provider '{provider_name}'.")


def _instantiate_provider(
    *,
    backend: str,
    model: str,
    provider_cfg: Any,
    spec: Any,
    config: Config,
) -> LLMProvider:
    """Instantiate the concrete provider class for ``backend``."""
    api_key = provider_cfg.api_key if provider_cfg else None
    extra_headers = provider_cfg.extra_headers if provider_cfg else None
    extra_body = getattr(provider_cfg, "extra_body", None) if provider_cfg else None

    if backend == "openai_codex":
        from openpawlet.providers.openai_codex_provider import OpenAICodexProvider

        return OpenAICodexProvider(default_model=model)

    if backend == "github_copilot":
        from openpawlet.providers.github_copilot_provider import GitHubCopilotProvider

        return GitHubCopilotProvider(default_model=model)

    if backend == "azure_openai":
        from openpawlet.providers.azure_openai_provider import AzureOpenAIProvider

        return AzureOpenAIProvider(
            api_key=provider_cfg.api_key,
            api_base=provider_cfg.api_base,
            default_model=model,
        )

    if backend == "anthropic":
        from openpawlet.providers.anthropic_provider import AnthropicProvider

        return AnthropicProvider(
            api_key=api_key,
            api_base=config.get_api_base(model),
            default_model=model,
            extra_headers=extra_headers,
        )

    from openpawlet.providers.openai_compat_provider import OpenAICompatProvider

    return OpenAICompatProvider(
        api_key=api_key,
        api_base=config.get_api_base(model),
        default_model=model,
        extra_headers=extra_headers,
        spec=spec,
        extra_body=extra_body,
    )


def build_provider(
    config: Config,
    *,
    error_handler: Callable[[str], NoReturn] | None = None,
    attach_token_usage: bool = True,
) -> LLMProvider:
    """Build an :class:`LLMProvider` from ``config``.

    Args:
        config: Loaded OpenPawlet ``Config``.
        error_handler: Called with a human-readable message when configuration
            is invalid.  Must not return.  Defaults to raising ``ValueError``.
        attach_token_usage: When ``True`` (default), wires up the token-usage
            JSONL recorder against the workspace.

    Returns:
        A configured provider with ``GenerationSettings`` applied.
    """
    error = error_handler or _default_error_handler

    defaults = config.agents.defaults
    model = defaults.model
    provider_name = config.get_provider_name(model)
    provider_cfg = config.get_provider(model)
    spec = find_by_name(provider_name) if provider_name else None
    backend = spec.backend if spec else "openai_compat"

    _validate_provider_credentials(
        backend=backend,
        model=model,
        provider_cfg=provider_cfg,
        spec=spec,
        error=error,
    )

    provider = _instantiate_provider(
        backend=backend,
        model=model,
        provider_cfg=provider_cfg,
        spec=spec,
        config=config,
    )

    provider.generation = GenerationSettings(
        temperature=defaults.temperature,
        max_tokens=defaults.max_tokens,
        reasoning_effort=defaults.reasoning_effort,
    )

    if attach_token_usage:
        from openpawlet.utils.token_usage_jsonl import attach_token_usage_jsonl

        attach_token_usage_jsonl(
            provider,
            config.workspace_path,
            timezone=defaults.timezone,
        )

    return provider


def _instance_to_inner_provider(
    instance: LLMProviderInstance,
    *,
    config: Config,
) -> LLMProvider | None:
    """Build the *concrete* provider for an instance (no failover wrapping).

    Returns ``None`` when the instance is disabled, has no spec, or fails
    validation (missing key for non-OAuth/local backends).
    """
    if not instance.enabled:
        return None
    spec = find_by_name(instance.provider) if instance.provider else None
    backend = spec.backend if spec else "openai_compat"
    api_key = instance.first_key()
    api_base = instance.api_base
    extra_headers = dict(instance.extra_headers) if instance.extra_headers else None
    model = instance.model or config.agents.defaults.model

    if backend == "openai_codex":
        from openpawlet.providers.openai_codex_provider import OpenAICodexProvider

        return OpenAICodexProvider(default_model=model)

    if backend == "github_copilot":
        from openpawlet.providers.github_copilot_provider import GitHubCopilotProvider

        return GitHubCopilotProvider(default_model=model)

    if backend == "azure_openai":
        if not api_key or not api_base:
            return None
        from openpawlet.providers.azure_openai_provider import AzureOpenAIProvider

        return AzureOpenAIProvider(
            api_key=api_key,
            api_base=api_base,
            default_model=model,
        )

    if backend == "anthropic":
        from openpawlet.providers.anthropic_provider import AnthropicProvider

        effective_base = api_base or (spec.default_api_base if spec else None)
        return AnthropicProvider(
            api_key=api_key,
            api_base=effective_base,
            default_model=model,
            extra_headers=extra_headers,
        )

    needs_key = not (spec and (spec.is_oauth or spec.is_local or spec.is_direct))
    if needs_key and not api_key:
        return None

    from openpawlet.providers.openai_compat_provider import OpenAICompatProvider

    effective_base = api_base or (spec.default_api_base if spec else None)
    inst_extra_body = getattr(instance, "extra_body", None)

    return OpenAICompatProvider(
        api_key=api_key,
        api_base=effective_base,
        default_model=model,
        extra_headers=extra_headers,
        spec=spec,
        extra_body=inst_extra_body,
    )


def build_provider_for_instance(
    *,
    instance_id: str,
    config: Config,
    store: LLMProviderStore | None = None,
    attach_token_usage: bool = True,
    error_handler: Callable[[str], NoReturn] | None = None,
) -> LLMProvider:
    """Build a fail-over-aware :class:`LLMProvider` for the given instance id.

    The returned provider is a :class:`MultiInstanceFailoverProvider` that
    routes each call through (1) optional intra-instance key rotation and
    (2) the configured fail-over chain.

    Raises ``ValueError`` (or whatever ``error_handler`` chooses) when the
    primary instance does not exist or cannot produce a working inner
    provider.
    """
    error = error_handler or _default_error_handler
    store = store or LLMProviderStore(config.workspace_path)

    primary = store.get(instance_id)
    if primary is None:
        error(f"LLM provider instance not found: {instance_id!r}")
    assert primary is not None  # for type checkers; error() is NoReturn

    def _factory(iid: str) -> LLMProvider | None:
        instance = store.get(iid)
        if instance is None:
            return None
        inner = _instance_to_inner_provider(instance, config=config)
        if inner is None:
            return None
        # Wrap with key rotation when the instance has multiple keys.
        key_values = instance.key_values()
        if len(key_values) > 1:
            inner = KeyRotatingProvider(
                inner=inner,
                api_keys=key_values,
                triggers=set(instance.failover_on),
            )
        return inner

    # Validate the primary works, otherwise we'd return a wrapper that
    # silently fails on the very first call.
    if _factory(primary.id) is None:
        error(
            f"LLM provider instance {primary.id!r} ({primary.provider}) "
            f"is missing required credentials or is disabled."
        )

    wrapper = MultiInstanceFailoverProvider(
        primary_id=primary.id,
        instance_provider_factory=_factory,
        instance_lookup=store.get,
    )

    defaults = config.agents.defaults
    wrapper.generation = GenerationSettings(
        temperature=defaults.temperature,
        max_tokens=defaults.max_tokens,
        reasoning_effort=defaults.reasoning_effort,
    )

    if attach_token_usage:
        from openpawlet.utils.token_usage_jsonl import attach_token_usage_jsonl

        attach_token_usage_jsonl(
            wrapper,
            config.workspace_path,
            timezone=defaults.timezone,
        )

    return wrapper


def find_default_instance_id(config: Config, store: LLMProviderStore | None = None) -> str | None:
    """Pick the *default* instance id for ``config``.

    Selection order — first match wins:

    1. The instance the user explicitly flagged ``is_default=True``
       (provided it can actually serve traffic).
    2. An instance whose ``model`` exactly matches
       ``agents.defaults.model`` *and* is serviceable.
    3. An instance whose ``provider`` registry name matches the
       provider hint inferred from the model string (e.g. model
       ``deepseek-v3.2`` → provider ``deepseek``) *and* is serviceable.
    4. The first serviceable instance in declaration order.
    5. ``None`` (callers fall back to the legacy :func:`build_provider`
       path so users without any working LLM-instance setup still get a
       useful error from the credential validator).

    Disabled instances and instances missing required credentials are
    never picked — that's the bug fix that prevents the ``no-key``
    OpenAI fallback when migration leaves empty ``legacy-custom`` rows
    around.
    """
    store = store or LLMProviderStore(config.workspace_path)
    instances = list(store.list_instances())
    if not instances:
        return None

    serviceable = [inst for inst in instances if inst.can_serve()]
    if not serviceable:
        # The user has instances configured but none of them work; fall
        # back to legacy ProvidersConfig so the existing error messages
        # still surface a meaningful "API key missing" diagnostic.
        return None

    # 1. Explicit user pick.
    for inst in serviceable:
        if inst.is_default:
            return inst.id

    target_model = (config.agents.defaults.model or "").strip()

    # 2. Exact model match.
    if target_model:
        for inst in serviceable:
            if (inst.model or "").strip() == target_model:
                return inst.id

    # 3. Provider-name heuristic on the model string.
    if target_model:
        hinted = _infer_provider_from_model(target_model)
        if hinted is not None:
            for inst in serviceable:
                if (inst.provider or "").strip().lower() == hinted:
                    return inst.id

    # 4. Anything that works.
    return serviceable[0].id


def _infer_provider_from_model(model: str) -> str | None:
    """Map a model string like ``deepseek-v3.2`` to a registry name.

    Mirrors the keyword + prefix matching used by
    :meth:`Config._match_provider` so instance picking lines up with the
    legacy provider routing logic.  Returns ``None`` when no provider
    keyword/prefix matches.
    """
    s = (model or "").strip().lower()
    if not s:
        return None
    prefix = s.split("/", 1)[0] if "/" in s else ""
    normalized_prefix = prefix.replace("-", "_")
    normalized_full = s.replace("-", "_")
    # Provider name as an explicit prefix wins, e.g. ``anthropic/claude-...``.
    from openpawlet.providers.registry import PROVIDERS

    for spec in PROVIDERS:
        if normalized_prefix and normalized_prefix == spec.name:
            return spec.name
    # Otherwise, fall back to keyword matching (skip generic prefixes
    # like "openai" so we don't accidentally route "gpt-4o" to a custom
    # OAuth-only entry).
    for spec in PROVIDERS:
        for kw in spec.keywords:
            kwl = kw.lower()
            if kwl in s or kwl.replace("-", "_") in normalized_full:
                return spec.name
    return None


def build_default_provider(
    config: Config,
    *,
    error_handler: Callable[[str], NoReturn] | None = None,
    attach_token_usage: bool = True,
) -> LLMProvider:
    """Pick the right :class:`LLMProvider`: instance-based when configured,
    legacy ``ProvidersConfig`` block otherwise.
    """
    store = LLMProviderStore(config.workspace_path)
    iid = find_default_instance_id(config, store)
    if iid is not None:
        return build_provider_for_instance(
            instance_id=iid,
            config=config,
            store=store,
            attach_token_usage=attach_token_usage,
            error_handler=error_handler,
        )
    return build_provider(
        config,
        error_handler=error_handler,
        attach_token_usage=attach_token_usage,
    )


__all__ = [
    "build_default_provider",
    "build_provider",
    "build_provider_for_instance",
    "find_default_instance_id",
]
