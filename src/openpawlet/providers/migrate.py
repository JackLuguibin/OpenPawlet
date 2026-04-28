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

from openpawlet.providers.instances import (
    DEFAULT_FAILOVER_TRIGGERS,
    LLMProviderInstance,
    LLMProviderStore,
    llm_providers_json_path,
)
from openpawlet.providers.registry import find_by_name

if TYPE_CHECKING:
    from openpawlet.config.schema import Config


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
    # Migration policy: only carry over rows the user actually
    # configured.  Empty OAuth / local / direct entries used to be
    # migrated as well, which left the workspace with a pile of
    # "instances" that the runtime would happily try to dispatch to
    # — yielding the infamous "Incorrect API key provided: no-key"
    # error against api.openai.com when the empty ``custom`` row
    # ended up first in the list.  Skip everything that doesn't
    # carry at least one of (api_key, api_base) so the resulting
    # ``llm_providers.json`` only contains rows worth picking.
    if not api_key and not api_base:
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
        # Auto-promote when this is the only viable migration target;
        # the ``migrate_legacy_providers`` post-processing step takes
        # care of guaranteeing a single default across the whole batch.
        is_default=False,
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
        # Promote a default so the runtime doesn't have to fall back to
        # the legacy ``ProvidersConfig`` block on first boot.  Heuristic:
        # prefer an instance whose ``model`` slot we'd auto-pick anyway
        # (matches ``agents.defaults.model`` or its provider keyword),
        # otherwise just take the first migrated row.
        from openpawlet.providers.factory import _infer_provider_from_model  # noqa: PLC0415

        target_model = (config.agents.defaults.model or "").strip().lower()
        hinted = _infer_provider_from_model(target_model) if target_model else None
        chosen_idx = 0
        if hinted is not None:
            for i, inst in enumerate(migrated):
                if inst.provider.lower() == hinted:
                    chosen_idx = i
                    break
        migrated[chosen_idx] = migrated[chosen_idx].model_copy(
            update={"is_default": True}
        )
        store.replace_all(migrated)
        logger.info(
            "[migrate] wrote {} LLM provider instances to {} (default={})",
            len(migrated),
            path,
            migrated[chosen_idx].id,
        )
    else:
        # Touch an empty file so subsequent calls short-circuit on "no
        # instances yet" without re-reading the legacy block every boot.
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_text('{"instances": []}\n', encoding="utf-8")
    return len(migrated)


def heal_unusable_legacy_instances(workspace: Path) -> int:
    """Drop ``legacy-*`` instances that were migrated empty by an older build.

    Earlier versions of :func:`_legacy_provider_to_instance` migrated
    every provider — even OAuth / local / direct backends with no key
    and no api_base — which produced unusable rows like ``legacy-custom``
    that the default-instance picker would happily route traffic to.
    This one-shot cleanup removes such rows on startup.

    Returns the number of instances removed.
    """
    store = LLMProviderStore(workspace)
    instances = store.list_instances()
    if not instances:
        return 0

    def _is_unusable_legacy(inst: LLMProviderInstance) -> bool:
        if not inst.id.startswith("legacy-"):
            return False
        if inst.is_default:
            # User picked it explicitly — respect that choice.
            return False
        # Empty key + empty base on a backend that needs credentials.
        has_key = bool(inst.first_key())
        has_base = bool((inst.api_base or "").strip())
        return not has_key and not has_base

    keep = [inst for inst in instances if not _is_unusable_legacy(inst)]
    removed = len(instances) - len(keep)
    if removed == 0:
        return 0

    # If the cleanup left us without a default but at least one
    # serviceable instance survived, promote the first one — most
    # workspaces will have exactly one real key after this trim.
    if not any(inst.is_default for inst in keep):
        for i, inst in enumerate(keep):
            if inst.can_serve():
                keep[i] = inst.model_copy(update={"is_default": True})
                break

    store.replace_all(keep)
    logger.info(
        "[migrate] heal_unusable_legacy_instances dropped {} empty rows",
        removed,
    )
    return removed


__all__ = ["heal_unusable_legacy_instances", "migrate_legacy_providers"]
