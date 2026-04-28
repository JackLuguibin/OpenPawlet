"""One-shot migration: legacy ``ProvidersConfig`` (single-instance per provider)
→ ``llm_providers.json`` (multi-instance store).

Goal: every provider with a non-empty ``api_key`` in ``config.json``
becomes a corresponding :class:`LLMProviderInstance` so the new UI shows
the user's existing setup without further action.  Already-migrated
workspaces (file exists with at least one instance) are left alone.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from loguru import logger

from nanobot.providers.instances import (
    DEFAULT_FAILOVER_TRIGGERS,
    LLMProviderInstance,
    LLMProviderStore,
    llm_providers_json_path,
)
from nanobot.providers.registry import find_by_name

if TYPE_CHECKING:
    from nanobot.config.schema import Config


def _legacy_provider_to_instance(
    *,
    name: str,
    config: Config,
) -> LLMProviderInstance | None:
    """Build a single LLMProviderInstance from legacy ``ProvidersConfig.<name>``.

    Returns ``None`` when the legacy block has no API key + isn't an
    OAuth/local backend (nothing to preserve).
    """
    provider_cfg = getattr(config.providers, name, None)
    if provider_cfg is None:
        return None
    spec = find_by_name(name)
    api_key = (provider_cfg.api_key or "").strip()
    api_base = (provider_cfg.api_base or "").strip()
    extra_headers = dict(provider_cfg.extra_headers or {})
    is_oauth = bool(spec and spec.is_oauth)
    is_local = bool(spec and spec.is_local)
    is_direct = bool(spec and spec.is_direct)
    # Skip obviously empty single-instance blocks unless this provider
    # doesn't need an API key (OAuth / Ollama / OVMS).
    if not api_key and not (is_oauth or is_local or is_direct):
        return None

    label = spec.label if spec else name.title()
    instance_id = f"legacy-{name}".replace("_", "-")
    return LLMProviderInstance(
        id=instance_id,
        name=label,
        description=f"Migrated from legacy providers.{name} block",
        provider=name,
        model=None,
        api_keys=[{"label": "primary", "value": api_key}] if api_key else [],
        api_base=api_base or None,
        extra_headers=extra_headers,
        timeout_s=None,
        failover_instance_ids=[],
        failover_on=list(DEFAULT_FAILOVER_TRIGGERS),
        enabled=True,
    )


def migrate_legacy_providers(workspace: Path, config: Config) -> int:
    """Run the migration once; returns the number of instances written.

    Idempotent: skips when ``llm_providers.json`` already has any
    instance.  Workspaces that have never used a provider key end up
    with an empty file (still safe — the runtime falls back to legacy
    ``ProvidersConfig`` until the user adds an instance).
    """
    path = llm_providers_json_path(workspace)
    store = LLMProviderStore(workspace)
    existing = store.list_instances()
    if existing:
        return 0

    migrated: list[LLMProviderInstance] = []
    # ``ProvidersConfig`` field names are exactly the provider registry
    # names; walk them via Pydantic's declared model_fields so we don't
    # accidentally pick up methods or computed properties.
    for field_name in type(config.providers).model_fields:
        try:
            inst = _legacy_provider_to_instance(name=field_name, config=config)
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("[migrate] provider {} → instance failed: {}", field_name, exc)
            continue
        if inst is not None:
            migrated.append(inst)

    if migrated:
        store.replace_all(migrated)
        logger.info(
            "[migrate] wrote {} LLM provider instances to {}", len(migrated), path
        )
    else:
        # Touch an empty file so subsequent calls short-circuit on "no
        # instances yet" without re-reading the legacy block every boot.
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_text('{"instances": []}\n', encoding="utf-8")
    return len(migrated)


__all__ = ["migrate_legacy_providers"]
