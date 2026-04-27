"""Single source of truth for building an :class:`LLMProvider` from a ``Config``.

Both the CLI and the SDK previously duplicated the routing/validation logic for
choosing a provider backend.  This module centralizes that logic so callers only
need to decide *how* to surface configuration errors (raise an exception, print
an error in a CLI, etc.) via the ``error_handler`` callable.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Any, NoReturn

from nanobot.providers.base import GenerationSettings, LLMProvider
from nanobot.providers.registry import find_by_name

if TYPE_CHECKING:
    from nanobot.config.schema import Config


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

    if backend == "openai_codex":
        from nanobot.providers.openai_codex_provider import OpenAICodexProvider

        return OpenAICodexProvider(default_model=model)

    if backend == "github_copilot":
        from nanobot.providers.github_copilot_provider import GitHubCopilotProvider

        return GitHubCopilotProvider(default_model=model)

    if backend == "azure_openai":
        from nanobot.providers.azure_openai_provider import AzureOpenAIProvider

        return AzureOpenAIProvider(
            api_key=provider_cfg.api_key,
            api_base=provider_cfg.api_base,
            default_model=model,
        )

    if backend == "anthropic":
        from nanobot.providers.anthropic_provider import AnthropicProvider

        return AnthropicProvider(
            api_key=api_key,
            api_base=config.get_api_base(model),
            default_model=model,
            extra_headers=extra_headers,
        )

    from nanobot.providers.openai_compat_provider import OpenAICompatProvider

    return OpenAICompatProvider(
        api_key=api_key,
        api_base=config.get_api_base(model),
        default_model=model,
        extra_headers=extra_headers,
        spec=spec,
    )


def build_provider(
    config: Config,
    *,
    error_handler: Callable[[str], NoReturn] | None = None,
    attach_token_usage: bool = True,
) -> LLMProvider:
    """Build an :class:`LLMProvider` from ``config``.

    Args:
        config: Loaded nanobot ``Config``.
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
        from nanobot.utils.token_usage_jsonl import attach_token_usage_jsonl

        attach_token_usage_jsonl(
            provider,
            config.workspace_path,
            timezone=defaults.timezone,
        )

    return provider


__all__ = ["build_provider"]
