"""CRUD API for LLM provider *instances* (multi-key + fail-over capable).

The list/get endpoints **never return plaintext API keys** — every
``apiKeys[*].value`` is replaced with a masked preview (``sk-•••••3a4f``)
plus a ``valueLength`` hint and the original ``id`` / ``label``.  The
plaintext is reachable only through the explicit
``POST /{id}/keys/{key_id}/reveal`` endpoint, which is rate-friendly to
audit (POST shows up in access logs while GET often does not).

API key edits are routed through dedicated sub-resource endpoints so the
client never has to round-trip an entire (potentially partially masked)
key list back to the server.

Endpoints (all under ``/api/v1/bots/{bot_id}/llm-providers``):

Top-level instance management
* ``GET    /``                         list every persisted instance (masked)
* ``POST   /``                         create a new instance
* ``GET    /{id}``                     fetch one instance (masked)
* ``PUT    /{id}``                     replace non-key fields on an instance
* ``DELETE /{id}``                     remove instance + strip dangling refs
* ``GET    /registry``                 list available provider backends
* ``POST   /{id}/test``                credential check via a tiny chat call

Per-instance API key management
* ``GET    /{id}/keys``                list this instance's keys (masked)
* ``POST   /{id}/keys``                add one key {label, value}
* ``PATCH  /{id}/keys/{key_id}``       update label and/or rotate value
* ``DELETE /{id}/keys/{key_id}``       remove one key
* ``POST   /{id}/keys/reorder``        reorder keys by id list
* ``POST   /{id}/keys/{key_id}/reveal`` return one key's plaintext value
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request, status
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from console.server.bot_workspace import workspace_root
from console.server.http_errors import bad_request, not_found, not_found_detail
from console.server.config_apply import reload_embedded_then_broadcast_snapshots
from console.server.models import DataResponse, OkBody
from openpawlet.providers.instances import (
    ALL_FAILOVER_TRIGGERS,
    DEFAULT_FAILOVER_TRIGGERS,
    ApiKeyEntry,
    LLMProviderInstance,
    LLMProviderStore,
    generate_api_key_id,
    generate_instance_id,
    mask_api_key,
)
from openpawlet.providers.registry import PROVIDERS


async def _after_provider_change(request: Request, bot_id: str | None) -> None:
    """Reload embedded runtime from disk after ``llm_providers.json`` writes, then broadcast SPA snapshots."""
    await reload_embedded_then_broadcast_snapshots(request.app, bot_id)


router = APIRouter(prefix="/bots/{bot_id}/llm-providers", tags=["LLM Providers"])


# ---------------------------------------------------------------------------
# Request / response shapes
# ---------------------------------------------------------------------------


class _CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="ignore",
    )


class ApiKeyCreate(_CamelModel):
    """Body for inline ``apiKeys`` rows on instance create.

    Both legacy ``str`` payloads and new structured rows are accepted at
    the validator level (see :class:`LLMProviderInstance`); this model is
    only used to document the new shape in OpenAPI.
    """

    id: str | None = None
    label: str = ""
    value: str


class LLMProviderInstanceCreate(_CamelModel):
    """Body for POST: ``id`` auto-generated when omitted."""

    id: str | None = None
    name: str
    description: str | None = None
    provider: str = "custom"
    model: str | None = None
    # Accept either v2 ``[{label, value}]`` or v1 ``["sk-..."]`` for
    # bootstrap convenience; the schema normalizer collapses them.
    api_keys: list[Any] = Field(default_factory=list)
    api_base: str | None = None
    extra_headers: dict[str, str] = Field(default_factory=dict)
    timeout_s: float | None = None
    failover_instance_ids: list[str] = Field(default_factory=list)
    failover_on: list[str] = Field(default_factory=lambda: list(DEFAULT_FAILOVER_TRIGGERS))
    enabled: bool = True
    is_default: bool = False


class LLMProviderInstanceUpdate(_CamelModel):
    """Body for PUT: any None field is left unchanged.

    ``apiKeys`` is intentionally **not** accepted here — use the
    dedicated ``/keys`` sub-resource instead so plaintext secrets do not
    have to round-trip through the SPA.  Older clients sending the field
    will simply have it ignored thanks to ``extra="ignore"``.
    """

    name: str | None = None
    description: str | None = None
    provider: str | None = None
    model: str | None = None
    api_base: str | None = None
    extra_headers: dict[str, str] | None = None
    timeout_s: float | None = None
    failover_instance_ids: list[str] | None = None
    failover_on: list[str] | None = None
    enabled: bool | None = None
    is_default: bool | None = None


class ApiKeyAddBody(_CamelModel):
    """``POST /{id}/keys`` body."""

    label: str = ""
    value: str


class ApiKeyPatchBody(_CamelModel):
    """``PATCH /{id}/keys/{key_id}`` body.

    Either or both fields may be set.  ``value`` empty/missing keeps the
    stored secret intact (so the UI can rename a key without resending
    its plaintext value).
    """

    label: str | None = None
    value: str | None = None


class ApiKeyReorderBody(_CamelModel):
    """``POST /{id}/keys/reorder`` body."""

    ordered_ids: list[str]


class ApiKeyRevealResult(_CamelModel):
    """``POST /{id}/keys/{key_id}/reveal`` response."""

    id: str
    value: str


class LLMProviderRegistryEntry(_CamelModel):
    name: str
    label: str
    backend: str
    is_gateway: bool
    is_local: bool
    is_oauth: bool
    is_direct: bool
    default_api_base: str = ""
    keywords: list[str] = Field(default_factory=list)


class LLMProviderTestResult(_CamelModel):
    ok: bool
    detail: str | None = None
    latency_ms: int | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _store(bot_id: str | None) -> LLMProviderStore:
    return LLMProviderStore(workspace_root(bot_id))


def _safe_payload(inst: LLMProviderInstance) -> dict[str, Any]:
    """Return the masked, public-safe representation of *inst*."""
    return inst.to_safe_payload()


def _safe_keys(inst: LLMProviderInstance) -> list[dict[str, Any]]:
    """Public, masked view of the instance's api_keys list."""
    payload = inst.to_safe_payload()
    keys = payload.get("apiKeys", [])
    return keys if isinstance(keys, list) else []


def _validate_triggers(values: list[str]) -> list[str]:
    """Reject unknown trigger names; preserves order, drops duplicates."""
    out: list[str] = []
    for v in values or []:
        token = str(v).strip().lower()
        if token in ALL_FAILOVER_TRIGGERS and token not in out:
            out.append(token)
    return out


def _require_instance(bot_id: str, instance_id: str) -> tuple[LLMProviderStore, LLMProviderInstance]:
    """Load an instance or raise 404."""
    store = _store(bot_id)
    inst = store.get(instance_id)
    if inst is None:
        not_found("Instance")
    return store, inst


def _find_key_index(inst: LLMProviderInstance, key_id: str) -> int:
    """Return the index of *key_id* in ``inst.api_keys`` or raise 404."""
    target = (key_id or "").strip()
    for i, entry in enumerate(inst.api_keys):
        if entry.id == target:
            return i
    not_found_detail("Key not found on instance")


# ---------------------------------------------------------------------------
# Top-level routes
# ---------------------------------------------------------------------------


@router.get("/registry", response_model=DataResponse[list[LLMProviderRegistryEntry]])
async def list_provider_registry(bot_id: str) -> DataResponse[list[LLMProviderRegistryEntry]]:
    """Return the metadata for every supported backend (used by the new instance form)."""
    _ = bot_id
    rows = [
        LLMProviderRegistryEntry(
            name=spec.name,
            label=spec.label,
            backend=spec.backend,
            is_gateway=spec.is_gateway,
            is_local=spec.is_local,
            is_oauth=spec.is_oauth,
            is_direct=spec.is_direct,
            default_api_base=spec.default_api_base,
            keywords=list(spec.keywords),
        )
        for spec in PROVIDERS
    ]
    return DataResponse(data=rows)


@router.get("", response_model=DataResponse[list[dict[str, Any]]])
async def list_instances(bot_id: str) -> DataResponse[list[dict[str, Any]]]:
    """List every persisted provider instance (api keys are masked)."""
    rows = [_safe_payload(inst) for inst in _store(bot_id).list_instances()]
    return DataResponse(data=rows)


@router.post("", response_model=DataResponse[dict[str, Any]], status_code=status.HTTP_200_OK)
async def create_instance(
    request: Request, bot_id: str, body: LLMProviderInstanceCreate
) -> DataResponse[dict[str, Any]]:
    """Create one new instance (id auto-generated if blank)."""
    store = _store(bot_id)
    iid = (body.id or "").strip() or generate_instance_id(name=body.name)
    if store.get(iid) is not None:
        bad_request(f"Instance id {iid!r} already exists")

    triggers = _validate_triggers(body.failover_on)

    try:
        instance = LLMProviderInstance(
            id=iid,
            name=body.name.strip() or iid,
            description=body.description,
            provider=(body.provider or "custom").strip(),
            model=(body.model or None),
            api_keys=list(body.api_keys),
            api_base=(body.api_base or None),
            extra_headers=dict(body.extra_headers or {}),
            timeout_s=body.timeout_s,
            failover_instance_ids=list(body.failover_instance_ids),
            failover_on=triggers,
            enabled=bool(body.enabled),
            is_default=bool(body.is_default),
        )
    except Exception as exc:  # pragma: no cover - validation error
        bad_request(str(exc), cause=exc)

    # If this is the very first instance and the user didn't ask for it
    # to be default, promote it anyway — otherwise the runtime would
    # have to fall back to the legacy ProvidersConfig path even when
    # the user just configured a perfectly good LLM source.
    if not instance.is_default:
        existing_defaults = [i for i in store.list_instances() if i.is_default]
        if not existing_defaults and instance.can_serve():
            instance = instance.model_copy(update={"is_default": True})

    store.upsert(instance)
    await _after_provider_change(request, bot_id)
    return DataResponse(data=_safe_payload(instance))


@router.get("/{instance_id}", response_model=DataResponse[dict[str, Any]])
async def get_instance(bot_id: str, instance_id: str) -> DataResponse[dict[str, Any]]:
    """Return one instance by id (api keys are masked)."""
    _, inst = _require_instance(bot_id, instance_id)
    return DataResponse(data=_safe_payload(inst))


@router.put("/{instance_id}", response_model=DataResponse[dict[str, Any]])
async def update_instance(
    request: Request, bot_id: str, instance_id: str, body: LLMProviderInstanceUpdate
) -> DataResponse[dict[str, Any]]:
    """Update non-key fields on an existing instance.

    API keys are managed through the ``/keys`` sub-resource.
    """
    store, existing = _require_instance(bot_id, instance_id)

    data = existing.model_dump(by_alias=False)
    if body.name is not None:
        data["name"] = body.name
    if body.description is not None:
        data["description"] = body.description
    if body.provider is not None:
        data["provider"] = body.provider
    if body.model is not None:
        data["model"] = body.model or None
    if body.api_base is not None:
        data["api_base"] = body.api_base or None
    if body.extra_headers is not None:
        data["extra_headers"] = dict(body.extra_headers)
    if body.timeout_s is not None:
        data["timeout_s"] = body.timeout_s
    if body.failover_instance_ids is not None:
        data["failover_instance_ids"] = list(body.failover_instance_ids)
    if body.failover_on is not None:
        data["failover_on"] = _validate_triggers(body.failover_on)
    if body.enabled is not None:
        data["enabled"] = bool(body.enabled)
    if body.is_default is not None:
        data["is_default"] = bool(body.is_default)

    try:
        updated = LLMProviderInstance.model_validate(data)
    except Exception as exc:
        bad_request(str(exc), cause=exc)

    store.upsert(updated)
    await _after_provider_change(request, bot_id)
    return DataResponse(data=_safe_payload(updated))


@router.post(
    "/{instance_id}/set-default",
    response_model=DataResponse[dict[str, Any]],
)
async def set_default_instance(
    request: Request, bot_id: str, instance_id: str
) -> DataResponse[dict[str, Any]]:
    """Mark *instance_id* as the workspace default; demote every other.

    Lighter-weight than PUT for the common "click ⭐ on a card" flow.
    """
    store = _store(bot_id)
    inst = store.set_default(instance_id)
    if inst is None:
        not_found("Instance")
    await _after_provider_change(request, bot_id)
    return DataResponse(data=_safe_payload(inst))


@router.delete("/{instance_id}", response_model=DataResponse[OkBody])
async def delete_instance(
    request: Request, bot_id: str, instance_id: str
) -> DataResponse[OkBody]:
    """Delete an instance and clean up references on others."""
    if not _store(bot_id).delete(instance_id):
        not_found("Instance")
    await _after_provider_change(request, bot_id)
    return DataResponse(data=OkBody())


@router.post("/{instance_id}/test", response_model=DataResponse[LLMProviderTestResult])
async def test_instance(bot_id: str, instance_id: str) -> DataResponse[LLMProviderTestResult]:
    """Best-effort credential test (one minimal chat call)."""
    import time

    from openpawlet.config.loader import load_config
    from openpawlet.providers.factory import build_provider_for_instance

    _require_instance(bot_id, instance_id)

    try:
        config = load_config()
        provider = build_provider_for_instance(
            instance_id=instance_id,
            config=config,
            attach_token_usage=False,
        )
    except Exception as exc:
        return DataResponse(
            data=LLMProviderTestResult(ok=False, detail=f"Build failed: {exc}")
        )

    started = time.monotonic()
    try:
        response = await provider.chat(
            messages=[{"role": "user", "content": "ping"}],
            max_tokens=5,
            temperature=0.0,
        )
    except Exception as exc:
        return DataResponse(
            data=LLMProviderTestResult(
                ok=False,
                detail=f"Call raised: {exc}",
                latency_ms=int((time.monotonic() - started) * 1000),
            )
        )

    latency = int((time.monotonic() - started) * 1000)
    if response.finish_reason == "error":
        return DataResponse(
            data=LLMProviderTestResult(
                ok=False,
                detail=(response.content or "Unknown error")[:200],
                latency_ms=latency,
            )
        )
    return DataResponse(
        data=LLMProviderTestResult(ok=True, detail="OK", latency_ms=latency)
    )


# ---------------------------------------------------------------------------
# /keys sub-resource
# ---------------------------------------------------------------------------


@router.get(
    "/{instance_id}/keys",
    response_model=DataResponse[list[dict[str, Any]]],
)
async def list_keys(bot_id: str, instance_id: str) -> DataResponse[list[dict[str, Any]]]:
    """List the masked API keys configured on this instance."""
    _, inst = _require_instance(bot_id, instance_id)
    return DataResponse(data=_safe_keys(inst))


@router.post(
    "/{instance_id}/keys",
    response_model=DataResponse[dict[str, Any]],
    status_code=status.HTTP_200_OK,
)
async def add_key(
    request: Request, bot_id: str, instance_id: str, body: ApiKeyAddBody
) -> DataResponse[dict[str, Any]]:
    """Append a new API key.  Returns the masked row including its new ``id``."""
    store, inst = _require_instance(bot_id, instance_id)
    value = (body.value or "").strip()
    if not value:
        bad_request("value is required")
    new_id = generate_api_key_id()
    existing_ids = {entry.id for entry in inst.api_keys}
    while new_id in existing_ids:
        new_id = generate_api_key_id()
    new_entry = ApiKeyEntry(id=new_id, label=(body.label or "").strip(), value=value)
    inst.api_keys.append(new_entry)
    store.upsert(inst)
    await _after_provider_change(request, bot_id)
    masked_row = {
        "id": new_entry.id,
        "label": new_entry.label,
        "masked": mask_api_key(new_entry.value),
        "valueLength": len(new_entry.value),
        "value": "",
    }
    return DataResponse(data=masked_row)


# NB: ``/keys/reorder`` is defined *before* the ``/keys/{key_id}`` routes so
# Starlette's first-match path resolver picks the static segment instead of
# treating ``reorder`` as a key id.


@router.post(
    "/{instance_id}/keys/reorder",
    response_model=DataResponse[list[dict[str, Any]]],
)
async def reorder_keys(
    request: Request, bot_id: str, instance_id: str, body: ApiKeyReorderBody
) -> DataResponse[list[dict[str, Any]]]:
    """Reorder keys to match ``ordered_ids``.

    Unknown ids are ignored; any existing keys missing from
    ``ordered_ids`` are appended at the end so we never silently drop a
    secret because of a stale client-side list.
    """
    store, inst = _require_instance(bot_id, instance_id)
    by_id = {entry.id: entry for entry in inst.api_keys}
    desired_ids = [kid for kid in (body.ordered_ids or []) if kid in by_id]
    seen: set[str] = set(desired_ids)
    new_order: list[ApiKeyEntry] = [by_id[k] for k in desired_ids]
    for entry in inst.api_keys:
        if entry.id not in seen:
            new_order.append(entry)
    inst.api_keys = new_order
    store.upsert(inst)
    await _after_provider_change(request, bot_id)
    return DataResponse(data=_safe_keys(inst))


@router.patch(
    "/{instance_id}/keys/{key_id}",
    response_model=DataResponse[dict[str, Any]],
)
async def patch_key(
    request: Request,
    bot_id: str,
    instance_id: str,
    key_id: str,
    body: ApiKeyPatchBody,
) -> DataResponse[dict[str, Any]]:
    """Update label and/or rotate the value of one key (label-only edits keep the secret)."""
    store, inst = _require_instance(bot_id, instance_id)
    idx = _find_key_index(inst, key_id)
    entry = inst.api_keys[idx]
    if body.label is not None:
        entry.label = body.label.strip()[:64]
    if body.value is not None and body.value.strip():
        entry.value = body.value.strip()
    inst.api_keys[idx] = entry
    store.upsert(inst)
    await _after_provider_change(request, bot_id)
    return DataResponse(
        data={
            "id": entry.id,
            "label": entry.label,
            "masked": mask_api_key(entry.value),
            "valueLength": len(entry.value),
            "value": "",
        }
    )


@router.delete(
    "/{instance_id}/keys/{key_id}",
    response_model=DataResponse[OkBody],
)
async def delete_key(
    request: Request, bot_id: str, instance_id: str, key_id: str
) -> DataResponse[OkBody]:
    """Remove one key from the instance."""
    store, inst = _require_instance(bot_id, instance_id)
    idx = _find_key_index(inst, key_id)
    inst.api_keys.pop(idx)
    store.upsert(inst)
    await _after_provider_change(request, bot_id)
    return DataResponse(data=OkBody())


@router.post(
    "/{instance_id}/keys/{key_id}/reveal",
    response_model=DataResponse[ApiKeyRevealResult],
)
async def reveal_key(
    bot_id: str, instance_id: str, key_id: str
) -> DataResponse[ApiKeyRevealResult]:
    """Return the plaintext value of one key.

    The endpoint uses ``POST`` (not ``GET``) on purpose: it's a deliberate
    de-masking action, and most reverse proxies / browser histories log
    GET URIs but not POST bodies/responses, which makes this a slightly
    safer transport for a secret that should still be rendered briefly.
    """
    _, inst = _require_instance(bot_id, instance_id)
    idx = _find_key_index(inst, key_id)
    entry = inst.api_keys[idx]
    return DataResponse(data=ApiKeyRevealResult(id=entry.id, value=entry.value))
