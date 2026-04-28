// LLM provider instance types (mirrors src/nanobot/providers/instances.py
// and src/console/server/routers/v1/llm_providers.py).
//
// API keys are returned in their **masked** form. The plaintext value is
// only ever delivered through the explicit reveal endpoint and should
// stay in component-local state — never in caches, query keys, or logs.

export type LLMFailoverTrigger =
  | 'timeout'
  | 'connection'
  | 'rate_limit'
  | 'server_5xx';

export const ALL_FAILOVER_TRIGGERS: ReadonlyArray<LLMFailoverTrigger> = [
  'timeout',
  'connection',
  'rate_limit',
  'server_5xx',
];

/**
 * One row inside an instance's `apiKeys` list, **as returned by the API**.
 *
 * The server replaces the secret with a masked preview so this object is
 * safe to persist in TanStack Query cache. To get the plaintext value
 * call `revealLLMProviderKey` and keep the result in transient component
 * state only.
 */
export interface MaskedApiKey {
  /** Stable opaque id used by the PATCH/DELETE/reorder/reveal endpoints. */
  id: string;
  /** Optional human label, e.g. "production" / "backup". */
  label: string;
  /** Display-safe preview, e.g. `sk-•••••3a4f`. */
  masked: string;
  /** Length of the original key value (lets the UI hint at correctness). */
  valueLength: number;
  /** Always empty in API responses; reserved for client-side draft state. */
  value: string;
}

export interface LLMProviderInstance {
  id: string;
  name: string;
  description: string | null;
  /** Registry name from PROVIDERS in providers/registry.py */
  provider: string;
  model: string | null;
  apiKeys: MaskedApiKey[];
  apiBase: string | null;
  extraHeaders: Record<string, string>;
  timeoutS: number | null;
  failoverInstanceIds: string[];
  failoverOn: LLMFailoverTrigger[];
  enabled: boolean;
  /**
   * When true, this instance is the workspace-wide default provider:
   * the runtime picks it when an Agent has no explicit
   * `provider_instance_id`. At most one instance is the default.
   */
  isDefault: boolean;
}

/** Body shape used when creating an instance — values are sent in plaintext. */
export interface ApiKeyDraft {
  label?: string;
  value: string;
}

export interface LLMProviderInstanceCreate {
  id?: string;
  name: string;
  description?: string | null;
  provider?: string;
  model?: string | null;
  apiKeys?: ApiKeyDraft[];
  apiBase?: string | null;
  extraHeaders?: Record<string, string>;
  timeoutS?: number | null;
  failoverInstanceIds?: string[];
  failoverOn?: LLMFailoverTrigger[];
  enabled?: boolean;
  isDefault?: boolean;
}

/**
 * Update body — `apiKeys` is **deliberately omitted** because the server
 * rejects key edits via PUT.  Use the `/keys` sub-resource APIs instead.
 */
export interface LLMProviderInstanceUpdate {
  name?: string;
  description?: string | null;
  provider?: string;
  model?: string | null;
  apiBase?: string | null;
  extraHeaders?: Record<string, string>;
  timeoutS?: number | null;
  failoverInstanceIds?: string[];
  failoverOn?: LLMFailoverTrigger[];
  enabled?: boolean;
  isDefault?: boolean;
}

export interface ApiKeyAddBody {
  label?: string;
  value: string;
}

export interface ApiKeyPatchBody {
  /** Pass `undefined` to leave unchanged. */
  label?: string;
  /** Pass `undefined` (or empty) to keep the existing secret. */
  value?: string;
}

export interface ApiKeyReorderBody {
  orderedIds: string[];
}

export interface ApiKeyRevealResult {
  id: string;
  value: string;
}

export interface LLMProviderRegistryEntry {
  name: string;
  label: string;
  backend: string;
  isGateway: boolean;
  isLocal: boolean;
  isOauth: boolean;
  isDirect: boolean;
  defaultApiBase: string;
  keywords: string[];
}

export interface LLMProviderTestResult {
  ok: boolean;
  detail: string | null;
  latencyMs: number | null;
}
