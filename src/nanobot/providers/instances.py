"""LLM provider *instance* schema and on-disk store.

A *provider instance* lets the user configure multiple credentials/endpoints
for the same provider backend.  For example two separate "DeepSeek" API
keys for fail-over, or three "Custom" OpenAI-compatible endpoints (each
with its own ``api_base`` + key).  Every instance gets a stable ``id`` so
agents can reference it explicitly via ``provider_instance_id``.

API keys are modelled as a list of :class:`ApiKeyEntry` objects (each
with its own opaque ``id``, ``label`` and secret ``value``) so the UI can
manipulate individual keys without ever shuttling other secrets through
the wire.  Reading an instance via the public API replaces ``value`` with
a masked preview (e.g. ``sk-•••••3a4f``) — the secret only ever leaves
the server through the explicit reveal endpoint.

Storage layout: ``<workspace>/llm_providers.json``::

    {
      "instances": [
        {
          "id": "ds-main",
          "name": "DeepSeek 主号",
          "description": "Production DeepSeek key with high quota",
          "provider": "deepseek",
          "model": "deepseek-v3.2",
          "api_keys": [
            {"id": "k_ab12", "label": "production", "value": "sk-..."},
            {"id": "k_cd34", "label": "backup",     "value": "sk-..."}
          ],
          "api_base": null,
          "extra_headers": {},
          "timeout_s": 60,
          "failover_instance_ids": ["ds-backup"],
          "failover_on": ["timeout", "connection", "rate_limit"],
          "enabled": true
        }
      ]
    }
"""

from __future__ import annotations

import json
import re
import threading
import uuid
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel

# Conditions that may trigger a fail-over to another instance.
# ``timeout``     - request timed out / connection-level error
# ``connection``  - network-level failure (DNS/SSL/socket)
# ``rate_limit``  - HTTP 429 / "rate limit" error from provider
# ``server_5xx``  - HTTP 5xx server error
FailoverTrigger = Literal["timeout", "connection", "rate_limit", "server_5xx"]

DEFAULT_FAILOVER_TRIGGERS: tuple[FailoverTrigger, ...] = ("timeout", "connection")

ALL_FAILOVER_TRIGGERS: tuple[FailoverTrigger, ...] = (
    "timeout",
    "connection",
    "rate_limit",
    "server_5xx",
)


_INSTANCE_ID_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_\-:]{0,63}$")
_KEY_ID_RE = re.compile(r"^k_[a-zA-Z0-9]{4,16}$")


def _slugify_instance_id(name: str) -> str:
    """Turn a human label into a safe instance id (best-effort)."""
    base = re.sub(r"[^a-zA-Z0-9]+", "-", (name or "").strip()).strip("-").lower()
    if not base:
        base = "provider"
    return base[:48]


def generate_api_key_id() -> str:
    """Stable, unique id for a single :class:`ApiKeyEntry` row.

    Used by the UI as a React key and by the PATCH endpoints so the
    client can reference an entry without sending its secret value.
    """
    return f"k_{uuid.uuid4().hex[:10]}"


def mask_api_key(value: str | None) -> str:
    """Return a display-safe preview of a secret API key.

    Layout: ``<prefix>•••••<suffix>``. Keys shorter than 8 chars are
    rendered as a single bullet line so we never leak partial keys.
    """
    if not value:
        return ""
    s = str(value)
    n = len(s)
    if n <= 8:
        return "•" * 8
    # Most provider keys have a prefix like "sk-", "sk-or-" — preserve up
    # to the first dash + 4 chars so users can still tell them apart.
    head_len = min(8, max(3, s.find("-") + 1 if "-" in s[:8] else 4))
    return f"{s[:head_len]}{'•' * 6}{s[-4:]}"


class ApiKeyEntry(BaseModel):
    """One credential row inside :attr:`LLMProviderInstance.api_keys`.

    The ``value`` field carries the *plaintext* secret on the disk
    representation only — it is never returned by the public API; see
    :func:`mask_api_key` and the ``GET /llm-providers`` payload.
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="ignore",
    )

    id: str
    label: str = ""
    value: str

    @field_validator("id", mode="before")
    @classmethod
    def _normalize_id(cls, v: object) -> str:
        s = str(v or "").strip()
        if not s:
            return generate_api_key_id()
        # Accept any short identifier from older payloads; only reject
        # outright if it contains characters we cannot use in URLs.
        if not _KEY_ID_RE.match(s) and not re.fullmatch(r"[a-zA-Z0-9_-]{1,32}", s):
            return generate_api_key_id()
        return s

    @field_validator("label", mode="before")
    @classmethod
    def _normalize_label(cls, v: object) -> str:
        if v is None:
            return ""
        return str(v).strip()[:64]

    @field_validator("value", mode="before")
    @classmethod
    def _normalize_value(cls, v: object) -> str:
        if v is None:
            return ""
        return str(v).strip()


class LLMProviderInstance(BaseModel):
    """One configured LLM provider instance (credential + routing bundle)."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="ignore",
    )

    id: str
    name: str
    description: str | None = None
    # Registry name from ``providers/registry.py`` (e.g. ``custom`` /
    # ``deepseek`` / ``anthropic``).
    provider: str = "custom"
    # Default model used when an Agent picks this instance without
    # specifying its own ``model`` override.
    model: str | None = None
    # Multiple keys for round-robin / fail-over within this instance.
    # Stored as structured rows so the UI can edit individual keys
    # without round-tripping the whole list.  ``list[str]`` payloads
    # from the legacy v1 schema are auto-upgraded.
    api_keys: list[ApiKeyEntry] = Field(default_factory=list)
    api_base: str | None = None
    extra_headers: dict[str, str] = Field(default_factory=dict)
    # Per-request timeout in seconds (None inherits provider default).
    timeout_s: float | None = None
    # Ordered chain of *other* instance ids to try when this one keeps
    # failing.  Cycles are broken at lookup time.
    failover_instance_ids: list[str] = Field(default_factory=list)
    # Conditions under which fail-over triggers.  Keep this small by
    # default to avoid surprising users with silent provider swaps.
    failover_on: list[FailoverTrigger] = Field(
        default_factory=lambda: list(DEFAULT_FAILOVER_TRIGGERS),
    )
    enabled: bool = True

    @field_validator("id")
    @classmethod
    def _validate_id(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("Instance id is required")
        if not _INSTANCE_ID_RE.match(v):
            raise ValueError(
                "Instance id may only contain letters, digits, dash, underscore, colon"
            )
        return v

    @field_validator("api_keys", mode="before")
    @classmethod
    def _normalize_keys(cls, v: object) -> list[dict[str, str]]:
        """Accept v1 ``list[str]`` *and* v2 ``list[{id,label,value}]`` payloads.

        - ``None`` / non-iterable → ``[]``
        - bare strings → wrapped as ``{id: <new>, label: "", value: s}``
        - dict rows → kept as-is, but blank ``id`` gets generated
        - dict rows with empty ``value`` are dropped (no point storing them)
        - duplicate ids get re-generated so PATCH operations stay unambiguous
        """
        if v is None:
            return []
        if isinstance(v, str):
            v = [v]
        if not isinstance(v, (list, tuple)):
            return []
        rows: list[dict[str, str]] = []
        seen_ids: set[str] = set()
        for item in v:
            value = ""
            label = ""
            kid = ""
            if isinstance(item, str):
                value = item.strip()
            elif isinstance(item, dict):
                value = str(item.get("value") or "").strip()
                label = str(item.get("label") or "").strip()
                kid = str(item.get("id") or "").strip()
            elif isinstance(item, ApiKeyEntry):
                value, label, kid = item.value, item.label, item.id
            else:
                continue
            if not value:
                continue
            if not kid or kid in seen_ids:
                kid = generate_api_key_id()
                while kid in seen_ids:
                    kid = generate_api_key_id()
            seen_ids.add(kid)
            rows.append({"id": kid, "label": label, "value": value})
        return rows

    @field_validator("failover_on", mode="before")
    @classmethod
    def _normalize_triggers(cls, v: object) -> list[str]:
        if v is None:
            return list(DEFAULT_FAILOVER_TRIGGERS)
        if isinstance(v, str):
            v = [v]
        if not isinstance(v, (list, tuple)):
            return list(DEFAULT_FAILOVER_TRIGGERS)
        out: list[str] = []
        for item in v:
            token = str(item).strip().lower()
            if token in ALL_FAILOVER_TRIGGERS and token not in out:
                out.append(token)
        return out

    # -- Convenience views ------------------------------------------------

    def key_values(self) -> list[str]:
        """Return raw key strings in display order (runtime use only)."""
        return [entry.value for entry in self.api_keys if entry.value]

    def first_key(self) -> str | None:
        """Convenience: first non-empty key value, or ``None``."""
        for entry in self.api_keys:
            if entry.value:
                return entry.value
        return None

    def to_safe_payload(self) -> dict[str, object]:
        """Public, masked representation for ``GET`` responses.

        Replaces every ``api_keys[*].value`` with a masked preview and
        adds a sibling ``masked`` field so the UI can render the row
        without ever holding the real secret.
        """
        data = self.model_dump(mode="json", by_alias=True, exclude_none=False)
        keys_out: list[dict[str, object]] = []
        for entry in self.api_keys:
            keys_out.append(
                {
                    "id": entry.id,
                    "label": entry.label,
                    "masked": mask_api_key(entry.value),
                    # Length hint is useful when the user wants to verify
                    # the right key is stored without revealing it.
                    "valueLength": len(entry.value or ""),
                    # Empty string keeps the field shape stable for the
                    # SPA without leaking anything.
                    "value": "",
                }
            )
        data["apiKeys"] = keys_out
        return data


class LLMProvidersFile(BaseModel):
    """Persistence wrapper for ``llm_providers.json``."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="ignore",
    )

    instances: list[LLMProviderInstance] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Filesystem helpers
# ---------------------------------------------------------------------------


def llm_providers_json_path(workspace: Path) -> Path:
    """Return ``<workspace>/llm_providers.json``."""
    return Path(workspace).expanduser() / "llm_providers.json"


# Coarse process-wide lock — provider edits happen via the console UI which
# is single-user; serialising writes is fine and avoids torn JSON files.
_FILE_LOCK = threading.RLock()


class LLMProviderStore:
    """Filesystem-backed CRUD store for :class:`LLMProviderInstance`.

    All mutations are atomic against ``llm_providers.json`` (write to
    ``.tmp`` then ``replace``).  The store is intentionally stateless —
    every read hits disk, so console edits made through one bot are
    immediately visible to the runtime in the same process.
    """

    def __init__(self, workspace: Path) -> None:
        self.workspace = Path(workspace).expanduser()

    # -- IO -----------------------------------------------------------------

    def path(self) -> Path:
        return llm_providers_json_path(self.workspace)

    def _read(self) -> LLMProvidersFile:
        path = self.path()
        if not path.is_file():
            return LLMProvidersFile()
        try:
            raw = path.read_text(encoding="utf-8")
            data = json.loads(raw) if raw.strip() else {}
        except (OSError, UnicodeError, json.JSONDecodeError):
            return LLMProvidersFile()
        if not isinstance(data, dict):
            return LLMProvidersFile()
        try:
            return LLMProvidersFile.model_validate(data)
        except Exception:
            return LLMProvidersFile()

    def _write(self, file: LLMProvidersFile) -> None:
        path = self.path()
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = file.model_dump(mode="json", by_alias=True, exclude_none=False)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)

    # -- Public API ---------------------------------------------------------

    def list_instances(self) -> list[LLMProviderInstance]:
        with _FILE_LOCK:
            return list(self._read().instances)

    def get(self, instance_id: str) -> LLMProviderInstance | None:
        iid = (instance_id or "").strip()
        if not iid:
            return None
        with _FILE_LOCK:
            for inst in self._read().instances:
                if inst.id == iid:
                    return inst
        return None

    def upsert(self, instance: LLMProviderInstance) -> LLMProviderInstance:
        """Insert or replace by ``id``; returns the persisted instance."""
        with _FILE_LOCK:
            file = self._read()
            updated = False
            for i, existing in enumerate(file.instances):
                if existing.id == instance.id:
                    file.instances[i] = instance
                    updated = True
                    break
            if not updated:
                file.instances.append(instance)
            self._write(file)
            return instance

    def delete(self, instance_id: str) -> bool:
        iid = (instance_id or "").strip()
        if not iid:
            return False
        with _FILE_LOCK:
            file = self._read()
            before = len(file.instances)
            file.instances = [inst for inst in file.instances if inst.id != iid]
            # Also strip dangling failover references so the chain stays valid.
            for inst in file.instances:
                if iid in inst.failover_instance_ids:
                    inst.failover_instance_ids = [
                        x for x in inst.failover_instance_ids if x != iid
                    ]
            if len(file.instances) == before:
                return False
            self._write(file)
            return True

    def replace_all(self, instances: list[LLMProviderInstance]) -> None:
        """Atomic bulk replace (used by import / migration)."""
        with _FILE_LOCK:
            self._write(LLMProvidersFile(instances=list(instances)))


# ---------------------------------------------------------------------------
# ID helpers
# ---------------------------------------------------------------------------


def generate_instance_id(*, name: str | None = None, prefix: str = "prov") -> str:
    """Generate a stable instance id; ``name`` is used as a slug hint."""
    slug = _slugify_instance_id(name or "")
    suffix = uuid.uuid4().hex[:6]
    base = slug or prefix
    return f"{base}-{suffix}"


__all__ = [
    "ALL_FAILOVER_TRIGGERS",
    "ApiKeyEntry",
    "DEFAULT_FAILOVER_TRIGGERS",
    "FailoverTrigger",
    "LLMProviderInstance",
    "LLMProviderStore",
    "LLMProvidersFile",
    "generate_api_key_id",
    "generate_instance_id",
    "llm_providers_json_path",
    "mask_api_key",
]
