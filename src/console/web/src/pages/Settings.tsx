import { useState, useEffect, useMemo, useCallback } from 'react';
import type { CSSProperties } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import type { ColumnsType } from 'antd/es/table';
import {
  Tabs,
  Form,
  Input,
  AutoComplete,
  InputNumber,
  Slider,
  Switch,
  Button,
  Spin,
  Card,
  Typography,
  Space,
  Select,
  Alert,
  Tooltip,
  Table,
  Empty,
  Segmented,
  Divider,
  Row,
  Col,
  Flex,
  theme,
  Collapse,
} from 'antd';
import {
  SaveOutlined,
  DownloadOutlined,
  KeyOutlined,
  CodeOutlined,
  ToolOutlined,
  EnvironmentOutlined,
  PlusOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import * as api from '../api/client';
import { useAppStore } from '../store';
import { formatQueryError } from '../utils/errors';
import { getCommonTimeZoneSelectOptions } from '../utils/timezones';
import { PageLayout } from '../components/PageLayout';
import { PAGE_PRIMARY_TITLE_CLASS } from '../utils/pageTitleClasses';
import { useBots } from '../hooks/useBots';
import LLMProvidersPanel from './settings/LLMProvidersPanel';
import type {
  AgentDefaultsJson,
  DreamConfigJson,
  SettingsGeneralToolsFormValues,
  ToolsConfig,
} from '../api/types';

const { Text } = Typography;

/**
 * Match Agents/Teams outer Card: rounded-md, /90 borders, light shadow.
 * `settings-surface-card` in index.css re-applies radius + shadow (global ant Card strips shadow).
 */
const SETTINGS_CARD_SURFACE =
  'settings-surface-card w-full overflow-hidden rounded-md border border-gray-200/90 shadow-sm dark:border-gray-700/80 dark:bg-gray-800/35';

/** Card grows to fill tab pane; header stays visible, body scrolls. */
const SETTINGS_SCROLL_CARD_CLASS = `${SETTINGS_CARD_SURFACE} min-h-0 flex flex-1 flex-col`;

const SETTINGS_SCROLL_CARD_STYLES: {
  header: CSSProperties;
  body: CSSProperties;
} = {
  header: { flexShrink: 0 },
  body: { flex: 1, minHeight: 0, overflowY: 'auto' },
};


type SettingsTab =
  | 'general'
  | 'providers'
  | 'tools'
  | 'environment';

const VALID_SETTINGS_TABS: ReadonlyArray<SettingsTab> = [
  'general',
  'providers',
  'tools',
  'environment',
];

/** Known ``tools.web.search.provider`` values; arbitrary strings are still allowed via Select. */
const WEB_SEARCH_PROVIDER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'duckduckgo', label: 'DuckDuckGo' },
  { value: 'brave', label: 'Brave' },
  { value: 'tavily', label: 'Tavily' },
  { value: 'searxng', label: 'SearXNG' },
  { value: 'jina', label: 'Jina' },
  { value: 'kagi', label: 'Kagi' },
];

function readSettingsTab(searchParams: URLSearchParams): SettingsTab {
  const raw = searchParams.get('tab') as SettingsTab | null;
  return raw && VALID_SETTINGS_TABS.includes(raw) ? raw : 'general';
}

/** Match backend registry ``name`` (snake_case) for ``agents.defaults.provider`` / instances. */
function normalizeRegistryProviderName(raw: string): string {
  const s = raw.trim().replace(/-/g, '_');
  if (!s) return '';
  if (s === s.toLowerCase()) return s;
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/** Normalized ``agents.defaults.provider`` for forms and API (registry snake_case, ``auto`` preserved). */
function normalizeAgentsDefaultProviderValue(raw: string | undefined | null): string | undefined {
  const p = (raw ?? '').trim();
  if (!p) return undefined;
  if (p.toLowerCase() === 'auto') return 'auto';
  return normalizeRegistryProviderName(p) || p;
}

/**
 * Read ``agents.defaults`` from GET /config payload.
 * Matches ``openpawlet.config.schema.AgentDefaults`` (``Base`` uses ``alias_generator=to_camel``):
 * canonical JSON keys are camelCase as in ``model_dump(mode="json", by_alias=True)``;
 * also accept snake_case keys from hand-edited ``config.json`` (``populate_by_name``).
 */
function readAgentDefaultsStr(
  defaults: AgentDefaultsJson | undefined,
  jsonAlias: string,
  pythonField: string,
  fallback: string,
): string {
  const d = defaults ?? {};
  const v = d[jsonAlias] ?? d[pythonField];
  if (typeof v !== 'string') return fallback;
  const t = v.trim();
  return t || fallback;
}

function readAgentDefaultsNum(
  defaults: AgentDefaultsJson | undefined,
  jsonAlias: string,
  pythonField: string,
  fallback: number,
): number {
  const d = defaults ?? {};
  const v = d[jsonAlias] ?? d[pythonField];
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** ``max_history_messages`` (+ nanobot-style ``max_messages``) for LLM history cap. */
function readMaxHistoryMessages(defaults: AgentDefaultsJson | undefined): number {
  const d = (defaults ?? {}) as Record<string, unknown>;
  const v = d.maxHistoryMessages ?? d.max_history_messages ?? d.max_messages;
  if (v === undefined || v === null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Schema allows null; UI treats empty/null as ``medium``. */
function readAgentDefaultsReasoningEffort(defaults: AgentDefaultsJson | undefined): string {
  const d = defaults ?? {};
  const v = d.reasoningEffort ?? d.reasoning_effort;
  if (typeof v !== 'string' || !v.trim()) return 'medium';
  return v.trim();
}

/** ``ToolsConfig`` JSON uses ``restrictToWorkspace``; legacy snake_case accepted. */
function readToolsRestrictToWorkspace(tools: ToolsConfig | undefined): boolean {
  const t = tools ?? {};
  const v = t.restrictToWorkspace ?? t.restrict_to_workspace;
  return Boolean(v);
}

function readAgentDefaultsBool(
  defaults: AgentDefaultsJson | undefined,
  camel: string,
  snake: string,
  fallback: boolean,
): boolean {
  const d = defaults ?? {};
  const v = (d as Record<string, unknown>)[camel] ?? (d as Record<string, unknown>)[snake];
  if (typeof v === 'boolean') return v;
  return fallback;
}

function readAgentDefaultsOptionalNum(
  defaults: AgentDefaultsJson | undefined,
  camel: string,
  snake: string,
): number | null {
  const d = defaults ?? {};
  const v = (d as Record<string, unknown>)[camel] ?? (d as Record<string, unknown>)[snake];
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function readProviderRetryMode(defaults: AgentDefaultsJson | undefined): 'standard' | 'persistent' {
  const d = defaults ?? {};
  const v =
    (d as Record<string, unknown>).providerRetryMode ??
    (d as Record<string, unknown>).provider_retry_mode;
  return v === 'persistent' ? 'persistent' : 'standard';
}

function readIdleCompactAfterMinutes(defaults: AgentDefaultsJson | undefined): number {
  const d = defaults ?? {};
  const v =
    (d as Record<string, unknown>).idleCompactAfterMinutes ??
    (d as Record<string, unknown>).sessionTtlMinutes ??
    (d as Record<string, unknown>).session_ttl_minutes;
  if (v === undefined || v === null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function readDisabledSkillsList(defaults: AgentDefaultsJson | undefined): string[] {
  const d = defaults ?? {};
  const raw =
    (d as Record<string, unknown>).disabledSkills ?? (d as Record<string, unknown>).disabled_skills;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((s) => s.trim());
}

function readDreamNested(
  defaults: AgentDefaultsJson | undefined,
): NonNullable<SettingsGeneralToolsFormValues['dream']> {
  const dream = (defaults?.dream ?? {}) as Record<string, unknown>;
  const num = (c: string, s: string, fb: number) => {
    const v = dream[c] ?? dream[s];
    if (v === undefined || v === null) return fb;
    const n = Number(v);
    return Number.isFinite(n) ? n : fb;
  };
  const mo = dream.modelOverride ?? dream.model_override;
  const annotate =
    typeof dream.annotateLineAges === 'boolean'
      ? dream.annotateLineAges
      : typeof dream.annotate_line_ages === 'boolean'
        ? dream.annotate_line_ages
        : true;
  return {
    intervalH: num('intervalH', 'interval_h', 2),
    maxBatchSize: num('maxBatchSize', 'max_batch_size', 20),
    maxIterations: num('maxIterations', 'max_iterations', 15),
    annotateLineAges: annotate,
    modelOverride: typeof mo === 'string' ? mo : '',
  };
}

function readToolWebNested(
  tools: ToolsConfig | undefined,
): NonNullable<SettingsGeneralToolsFormValues['toolWeb']> {
  const w = (tools?.web ?? {}) as Record<string, unknown>;
  const s = (w.search ?? {}) as Record<string, unknown>;
  const pick = (camel: string, snake: string, fallback: unknown) =>
    s[camel] !== undefined ? s[camel] : s[snake] !== undefined ? s[snake] : fallback;
  const proxy = w.proxy;
  return {
    enable: w.enable !== false,
    proxy: proxy === null || proxy === undefined ? '' : String(proxy),
    search: {
      provider: String(pick('provider', 'provider', 'duckduckgo') || 'duckduckgo'),
      apiKey: String(pick('apiKey', 'api_key', '') ?? ''),
      baseUrl: String(pick('baseUrl', 'base_url', '') ?? ''),
      maxResults: (() => {
        const v = pick('maxResults', 'max_results', 5);
        const n = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(n) ? n : 5;
      })(),
      timeout: (() => {
        const v = pick('timeout', 'timeout', 30);
        const n = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(n) ? n : 30;
      })(),
    },
  };
}

function readToolExecNested(
  tools: ToolsConfig | undefined,
): NonNullable<SettingsGeneralToolsFormValues['toolExec']> {
  const e = (tools?.exec ?? {}) as Record<string, unknown>;
  const pick = (camel: string, snake: string, fallback: unknown) =>
    e[camel] !== undefined ? e[camel] : e[snake] !== undefined ? e[snake] : fallback;
  const rawKeys = pick('allowedEnvKeys', 'allowed_env_keys', []);
  const allowedEnvKeys = Array.isArray(rawKeys)
    ? rawKeys.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
    : [];
  return {
    enable: pick('enable', 'enable', true) !== false,
    timeout: (() => {
      const v = pick('timeout', 'timeout', 60);
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : 60;
    })(),
    pathAppend: String(pick('pathAppend', 'path_append', '') ?? ''),
    sandbox: String(pick('sandbox', 'sandbox', '') ?? ''),
    allowedEnvKeys,
  };
}

function readToolMyNested(
  tools: ToolsConfig | undefined,
): NonNullable<SettingsGeneralToolsFormValues['toolMy']> {
  const m = (tools?.my ?? {}) as Record<string, unknown>;
  const allowSet = m.allowSet !== undefined ? m.allowSet : m.allow_set;
  return {
    enable: m.enable !== false,
    allowSet: Boolean(allowSet),
  };
}

function readToolSsrfWhitelist(tools: ToolsConfig | undefined): string[] {
  const t = (tools ?? {}) as Record<string, unknown>;
  const raw = t.ssrfWhitelist ?? t.ssrf_whitelist;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((s) => s.trim());
}

/**
 * Ant Design AutoComplete filters options against the current input text. When the field still
 * holds a full known value (e.g. default ``auto``), substring matching would hide every other
 * option because ``openai``.includes(``auto``) is false. If input equals some option's value,
 * show the full list so the user can change selection.
 */
function autoCompleteFilterOption(
  input: string,
  option: unknown,
  optionsList: ReadonlyArray<{ value?: string; label?: string }>,
): boolean {
  const q = (input || '').toLowerCase().trim();
  if (!q) return true;
  const ov = option as { value?: string; label?: string };
  const hay = `${ov?.value ?? ''} ${ov?.label ?? ''}`.toLowerCase();
  if (optionsList.some((o) => String(o.value ?? '').toLowerCase() === q)) {
    return true;
  }
  return hay.includes(q);
}

/** Tool sub-panels: title + right-aligned status (watches form via parent re-renders). */
function SettingsToolsCollapsePanelLabel({
  title,
  status,
  highlight,
}: {
  title: string;
  status: string;
  highlight: boolean;
}) {
  return (
    <div className="flex w-full min-w-0 items-center gap-3 pr-1">
      <span className="min-w-0 flex-1 truncate text-left font-medium">{title}</span>
      <span
        className={`shrink-0 text-xs font-semibold tabular-nums ${
          highlight ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-400 dark:text-gray-500'
        }`}
      >
        {status}
      </span>
    </div>
  );
}

export default function Settings() {
  const { token } = theme.useToken();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { addToast, currentBotId } = useAppStore();
  const { data: bots = [] } = useBots();
  const llmProvidersBotId =
    currentBotId || bots.find((b) => b.is_default)?.id || bots[0]?.id || null;
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = readSettingsTab(searchParams);
  const setActiveTab = useCallback(
    (next: SettingsTab) => {
      const params = new URLSearchParams(searchParams);
      if (next === 'general') {
        params.delete('tab');
      } else {
        params.set('tab', next);
      }
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );
  const [form] = Form.useForm<SettingsGeneralToolsFormValues>();
  const watchedModelRaw = Form.useWatch('model', form);
  const watchedProviderRaw = Form.useWatch('provider', form);
  const watchedDisabledSkills = Form.useWatch('disabledSkills', form);
  const watchedToolWebEnable = Form.useWatch(['toolWeb', 'enable'], form);
  const watchedToolExecEnable = Form.useWatch(['toolExec', 'enable'], form);
  const watchedToolMyEnable = Form.useWatch(['toolMy', 'enable'], form);
  const watchedToolMyAllowSet = Form.useWatch(['toolMy', 'allowSet'], form);
  const watchedToolSsrfWhitelist = Form.useWatch('toolSsrfWhitelist', form);

  const modelScopeTrimmed = useMemo(() => {
    const m = typeof watchedModelRaw === 'string' ? watchedModelRaw.trim() : '';
    return m;
  }, [watchedModelRaw]);

  const providerScopeNormalized = useMemo(() => {
    const v = normalizeAgentsDefaultProviderValue(
      typeof watchedProviderRaw === 'string' ? watchedProviderRaw : undefined,
    );
    if (!v || v === 'auto') return null;
    return normalizeRegistryProviderName(v) || v;
  }, [watchedProviderRaw]);

  const { data: config, isLoading } = useQuery({
    queryKey: ['config', currentBotId],
    queryFn: () => api.getConfig(currentBotId),
  });

  const { data: status } = useQuery({
    queryKey: ['status', currentBotId],
    queryFn: () => api.getStatus(currentBotId),
  });

  const { data: llmProviderInstances = [] } = useQuery({
    queryKey: ['llm-providers', llmProvidersBotId],
    queryFn: () => api.listLLMProviders(llmProvidersBotId!),
    enabled: !!llmProvidersBotId,
  });

  const { data: skillCatalog = [], isLoading: skillCatalogLoading } = useQuery({
    queryKey: ['skills', currentBotId],
    queryFn: () => api.listSkills(currentBotId),
  });

  const disabledSkillSelectOptions = useMemo(() => {
    const byValue = new Map<string, { value: string; label: string }>();
    for (const s of skillCatalog) {
      const desc =
        s.description && s.description.length > 96
          ? `${s.description.slice(0, 93)}…`
          : (s.description ?? '');
      const label = desc ? `${s.name} — ${desc}` : s.name;
      byValue.set(s.name, { value: s.name, label });
    }
    const selected = Array.isArray(watchedDisabledSkills) ? watchedDisabledSkills : [];
    for (const n of selected) {
      if (typeof n === 'string' && n.trim() && !byValue.has(n)) {
        byValue.set(n.trim(), { value: n.trim(), label: n.trim() });
      }
    }
    return Array.from(byValue.values()).sort((a, b) => a.value.localeCompare(b.value));
  }, [skillCatalog, watchedDisabledSkills]);

  const handleModelProviderLink = useCallback(
    (changed: Partial<SettingsGeneralToolsFormValues>, all: SettingsGeneralToolsFormValues) => {
      if ('model' in changed) {
        const m = String(changed.model ?? '').trim();
        if (!m) return;
        const matches = llmProviderInstances.filter(
          (i) => i.enabled && typeof i.model === 'string' && i.model.trim() === m,
        );
        if (matches.length < 1) return;
        const pick = matches.find((i) => i.isDefault) ?? matches[0];
        const prov = normalizeRegistryProviderName(
          typeof pick.provider === 'string' ? pick.provider : '',
        );
        if (!prov) return;
        const cur = normalizeAgentsDefaultProviderValue(
          typeof all.provider === 'string' ? all.provider : undefined,
        );
        if (cur !== prov) {
          form.setFieldsValue({ provider: prov });
        }
      }
      if ('provider' in changed) {
        const pNorm = normalizeAgentsDefaultProviderValue(
          typeof changed.provider === 'string' ? changed.provider : undefined,
        );
        const modelNow = String(all.model ?? '').trim();
        if (!modelNow || !pNorm || pNorm === 'auto') return;
        const targetP = normalizeRegistryProviderName(pNorm);
        const ok = llmProviderInstances.some(
          (i) =>
            i.enabled &&
            normalizeRegistryProviderName(typeof i.provider === 'string' ? i.provider : '') ===
              targetP &&
            typeof i.model === 'string' &&
            i.model.trim() === modelNow,
        );
        if (ok) return;
        const first = llmProviderInstances.find(
          (i) =>
            i.enabled &&
            normalizeRegistryProviderName(typeof i.provider === 'string' ? i.provider : '') ===
              targetP &&
            typeof i.model === 'string' &&
            i.model.trim() !== '',
        );
        if (first && typeof first.model === 'string') {
          form.setFieldsValue({ model: first.model.trim() });
        }
      }
    },
    [form, llmProviderInstances],
  );

  const configuredDefaultModel = useMemo(() => {
    const m = config?.agents?.defaults?.model;
    return typeof m === 'string' ? m.trim() : '';
  }, [config]);

  /**
   * Provider picker: tied to current model when the model matches an instance (narrow providers).
   * Still always offers ``auto`` plus providers from ``GET .../llm-providers``.
   */
  const providerAutocompleteOptions = useMemo(() => {
    const seen = new Set<string>();
    const opts: Array<{ value: string; label?: string }> = [];

    const push = (value: string, label?: string) => {
      const v = value.trim();
      if (!v || seen.has(v)) return;
      seen.add(v);
      opts.push(label ? { value: v, label } : { value: v });
    };

    push('auto');

    let candidates = llmProviderInstances.filter((i) => i.enabled);
    if (modelScopeTrimmed) {
      const narrowed = candidates.filter(
        (i) => typeof i.model === 'string' && i.model.trim() === modelScopeTrimmed,
      );
      if (narrowed.length > 0) candidates = narrowed;
    }

    const byRegistry = new Map<string, { registry: string; label: string }>();

    for (const inst of candidates) {
      const p = normalizeRegistryProviderName(typeof inst.provider === 'string' ? inst.provider : '');
      if (!p) continue;
      if (byRegistry.has(p)) continue;
      const name = typeof inst.name === 'string' ? inst.name.trim() : '';
      byRegistry.set(p, { registry: p, label: name ? `${p} (${name})` : p });
    }

    const sortedProviders = [...byRegistry.keys()].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }),
    );
    for (const p of sortedProviders) {
      const row = byRegistry.get(p)!;
      push(row.registry, row.label);
    }

    const curPv = normalizeAgentsDefaultProviderValue(
      typeof watchedProviderRaw === 'string' ? watchedProviderRaw : undefined,
    );
    if (curPv && curPv !== 'auto') {
      push(curPv);
    }

    return opts;
  }, [llmProviderInstances, modelScopeTrimmed, watchedProviderRaw]);

  /** Model suggestions: filtered by selected provider (non-auto) when instances define that scope. */
  const modelAutocompleteOptions = useMemo(() => {
    const seen = new Set<string>();
    const opts: Array<{ value: string; label?: string }> = [];

    for (const inst of llmProviderInstances) {
      if (!inst.enabled) continue;
      if (providerScopeNormalized) {
        const ip = normalizeRegistryProviderName(typeof inst.provider === 'string' ? inst.provider : '');
        if (ip !== providerScopeNormalized) continue;
      }
      const model = typeof inst.model === 'string' ? inst.model.trim() : '';
      if (!model || seen.has(model)) continue;
      seen.add(model);
      opts.push({
        value: model,
        label: `${inst.name} (${inst.provider}${model ? ` · ${model}` : ''})`,
      });
    }

    const pushBare = (raw: unknown) => {
      const v = typeof raw === 'string' ? raw.trim() : '';
      if (!v || seen.has(v)) return;
      seen.add(v);
      opts.push({ value: v });
    };

    if (!providerScopeNormalized) {
      pushBare(configuredDefaultModel);
      pushBare(status?.model);
    }

    const curModel = typeof watchedModelRaw === 'string' ? watchedModelRaw.trim() : '';
    if (curModel && !seen.has(curModel)) {
      seen.add(curModel);
      opts.push({ value: curModel });
    }

    return opts;
  }, [
    configuredDefaultModel,
    llmProviderInstances,
    providerScopeNormalized,
    status?.model,
    watchedModelRaw,
  ]);

  const { data: envData, isLoading: envLoading } = useQuery({
    queryKey: ['env', currentBotId],
    queryFn: () => api.getEnv(currentBotId),
  });

  const timeZoneOptions = useMemo(() => {
    const base = getCommonTimeZoneSelectOptions();
    const rawTz = config?.agents?.defaults?.timezone;
    const tz = typeof rawTz === 'string' ? rawTz.trim() : '';
    if (tz && !base.some((o) => o.value === tz)) {
      return [{ label: tz, value: tz }, ...base];
    }
    return base;
  }, [config]);

  const [envEntries, setEnvEntries] = useState<
    Array<{ key: string; value: string; execVisible: boolean }>
  >([]);
  useEffect(() => {
    if (envData?.vars) {
      const allowSet = new Set(envData.exec_visible_keys || []);
      setEnvEntries(
        Object.entries(envData.vars).map(([key, value]) => ({
          key,
          value,
          execVisible: allowSet.has(key),
        }))
      );
    } else if (envData && Object.keys(envData.vars || {}).length === 0) {
      setEnvEntries([]);
    }
  }, [envData]);


  useEffect(() => {
    if (config) {
      const defaults = config.agents?.defaults;
      const tools = config.tools;

      const ws =
        typeof defaults?.workspace === 'string' && defaults.workspace.trim()
          ? defaults.workspace.trim()
          : '~/.openpawlet/workspace';

      form.setFieldsValue({
        workspace: ws,
        model: typeof defaults?.model === 'string' ? defaults.model : '',
        provider: normalizeAgentsDefaultProviderValue(defaults?.provider as string | undefined) ?? 'auto',
        timezone: readAgentDefaultsStr(defaults, 'timezone', 'timezone', 'UTC'),
        maxTokens: readAgentDefaultsNum(defaults, 'maxTokens', 'max_tokens', 8192),
        contextWindowTokens: readAgentDefaultsNum(defaults, 'contextWindowTokens', 'context_window_tokens', 65536),
        maxToolIterations: readAgentDefaultsNum(defaults, 'maxToolIterations', 'max_tool_iterations', 200),
        maxHistoryMessages: readMaxHistoryMessages(defaults),
        temperature: readAgentDefaultsNum(defaults, 'temperature', 'temperature', 0.1),
        reasoningEffort: readAgentDefaultsReasoningEffort(defaults),
        restrictToWorkspace: readToolsRestrictToWorkspace(tools),
        providerRetryMode: readProviderRetryMode(defaults),
        maxToolResultChars: readAgentDefaultsNum(defaults, 'maxToolResultChars', 'max_tool_result_chars', 16000),
        contextBlockLimit: readAgentDefaultsOptionalNum(defaults, 'contextBlockLimit', 'context_block_limit'),
        unifiedSession: readAgentDefaultsBool(defaults, 'unifiedSession', 'unified_session', false),
        idleCompactAfterMinutes: readIdleCompactAfterMinutes(defaults),
        consolidationRatio: readAgentDefaultsNum(defaults, 'consolidationRatio', 'consolidation_ratio', 0.5),
        persistSessionTranscript: readAgentDefaultsBool(
          defaults,
          'persistSessionTranscript',
          'persist_session_transcript',
          true,
        ),
        transcriptIncludeFullToolResults: readAgentDefaultsBool(
          defaults,
          'transcriptIncludeFullToolResults',
          'transcript_include_full_tool_results',
          true,
        ),
        disabledSkills: readDisabledSkillsList(defaults),
        dream: readDreamNested(defaults),
        toolWeb: readToolWebNested(tools),
        toolExec: readToolExecNested(tools),
        toolMy: readToolMyNested(tools),
        toolSsrfWhitelist: readToolSsrfWhitelist(tools),
      });
    }
  }, [config, form]);

  const saveSettingsMutation = useMutation({
    mutationFn: async () => {
      const values = await form.validateFields();
      const {
        restrictToWorkspace,
        toolWeb,
        toolExec,
        toolMy,
        toolSsrfWhitelist,
        ...rest
      } = values;

      const disabledSkills = (rest.disabledSkills ?? [])
        .map((s) => String(s).trim())
        .filter(Boolean);

      const dreamPayload: DreamConfigJson = {
        intervalH: rest.dream.intervalH,
        maxBatchSize: rest.dream.maxBatchSize,
        maxIterations: rest.dream.maxIterations,
        annotateLineAges: rest.dream.annotateLineAges,
        modelOverride: rest.dream.modelOverride.trim() ? rest.dream.modelOverride.trim() : null,
      };

      await api.updateConfig(
        'agents',
        {
          defaults: {
            workspace: rest.workspace?.trim() || undefined,
            model: rest.model?.trim() || undefined,
            provider: normalizeAgentsDefaultProviderValue(rest.provider),
            timezone: (rest.timezone ?? '').trim() || 'UTC',
            maxTokens: rest.maxTokens,
            contextWindowTokens: rest.contextWindowTokens,
            maxToolIterations: rest.maxToolIterations,
            maxHistoryMessages: rest.maxHistoryMessages,
            temperature: rest.temperature,
            reasoningEffort: rest.reasoningEffort,
            providerRetryMode: rest.providerRetryMode,
            maxToolResultChars: rest.maxToolResultChars,
            contextBlockLimit: rest.contextBlockLimit ?? null,
            unifiedSession: rest.unifiedSession,
            idleCompactAfterMinutes: rest.idleCompactAfterMinutes,
            consolidationRatio: rest.consolidationRatio,
            persistSessionTranscript: rest.persistSessionTranscript,
            transcriptIncludeFullToolResults: rest.transcriptIncludeFullToolResults,
            disabledSkills,
            dream: dreamPayload,
          },
        },
        currentBotId
      );
      await api.updateConfig(
        'tools',
        {
          restrictToWorkspace,
          web: {
            enable: toolWeb.enable,
            proxy: toolWeb.proxy?.trim() ? toolWeb.proxy.trim() : null,
            search: {
              provider: (toolWeb.search.provider ?? '').trim() || 'duckduckgo',
              apiKey: (toolWeb.search.apiKey ?? '').trim(),
              baseUrl: (toolWeb.search.baseUrl ?? '').trim(),
              maxResults: toolWeb.search.maxResults,
              timeout: toolWeb.search.timeout,
            },
          },
          exec: {
            enable: toolExec.enable,
            timeout: toolExec.timeout,
            pathAppend: (toolExec.pathAppend ?? '').trim(),
            sandbox: (toolExec.sandbox ?? '').trim(),
            allowedEnvKeys: (toolExec.allowedEnvKeys ?? [])
              .map((s) => String(s).trim())
              .filter(Boolean),
          },
          my: {
            enable: toolMy.enable,
            allowSet: toolMy.allowSet,
          },
          ssrfWhitelist: (toolSsrfWhitelist ?? []).map((s) => String(s).trim()).filter(Boolean),
        },
        currentBotId
      );
    },
    onSuccess: () => {
      addToast({ type: 'success', message: t('settings.saved') });
      queryClient.invalidateQueries({ queryKey: ['config'] });
    },
    onError: (error: unknown) => {
      addToast({ type: 'error', message: formatQueryError(error) });
    },
  });

  const updateEnvMutation = useMutation({
    mutationFn: (payload: { vars: Record<string, string>; execVisibleKeys: string[] }) =>
      api.updateEnv(payload.vars, currentBotId, payload.execVisibleKeys),
    onSuccess: () => {
      addToast({
        type: 'success',
        message: t('settings.envSaved'),
      });
      queryClient.invalidateQueries({ queryKey: ['env'] });
      queryClient.invalidateQueries({ queryKey: ['config'] });
    },
    onError: (error) => {
      addToast({ type: 'error', message: formatQueryError(error) });
    },
  });

  const handleSave = () => {
    saveSettingsMutation.mutate();
  };

  const handleSaveEnv = () => {
    const vars: Record<string, string> = {};
    const execVisibleKeys: string[] = [];
    for (const { key, value, execVisible } of envEntries) {
      const k = key?.trim();
      if (!k) continue;
      vars[k] = value ?? '';
      if (execVisible) execVisibleKeys.push(k);
    }
    updateEnvMutation.mutate({ vars, execVisibleKeys });
  };

  const handleExportConfig = () => {
    const configStr = JSON.stringify(config, null, 2);
    const blob = new Blob([configStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'openpawlet-config.json';
    a.click();
    URL.revokeObjectURL(url);
    addToast({ type: 'success', message: t('settings.exported') });
  };

  type EnvTableRow = {
    rowIndex: number;
    key: string;
    value: string;
    execVisible: boolean;
  };

  const envTableColumns: ColumnsType<EnvTableRow> = useMemo(
    () => [
      {
        title: t('settings.envColKey'),
        key: 'name',
        width: 220,
        render: (_, record) => (
          <Input
            placeholder={t('settings.envKeyPh')}
            value={record.key}
            onChange={(e) => {
              const v = e.target.value;
              setEnvEntries((prev) => {
                const next = [...prev];
                next[record.rowIndex] = { ...next[record.rowIndex], key: v };
                return next;
              });
            }}
            className="font-mono"
          />
        ),
      },
      {
        title: t('settings.envColValue'),
        key: 'value',
        ellipsis: true,
        render: (_, record) => (
          <Input.Password
            placeholder={t('settings.envValuePh')}
            value={record.value}
            onChange={(e) => {
              const v = e.target.value;
              setEnvEntries((prev) => {
                const next = [...prev];
                next[record.rowIndex] = { ...next[record.rowIndex], value: v };
                return next;
              });
            }}
            className="font-mono"
          />
        ),
      },
      {
        title: t('settings.envExecVisibleLabel'),
        key: 'exec',
        width: 72,
        align: 'center',
        render: (_, record) => (
          <Tooltip title={t('settings.envExecVisibleHint')}>
            <Switch
              size="small"
              checked={record.execVisible}
              onChange={(checked) => {
                setEnvEntries((prev) => {
                  const next = [...prev];
                  next[record.rowIndex] = { ...next[record.rowIndex], execVisible: checked };
                  return next;
                });
              }}
            />
          </Tooltip>
        ),
      },
      {
        title: t('settings.envColActions'),
        key: 'actions',
        width: 56,
        align: 'center',
        render: (_, record) => (
          <Tooltip title={t('common.delete')}>
            <Button
              type="text"
              danger
              icon={<DeleteOutlined />}
              aria-label={t('common.delete')}
              onClick={() =>
                setEnvEntries((prev) => prev.filter((_, i) => i !== record.rowIndex))
              }
            />
          </Tooltip>
        ),
      },
    ],
    [t],
  );

  if (isLoading) {
    return (
      <PageLayout variant="center">
        <Spin size="large" />
      </PageLayout>
    );
  }

  const envTabContent = (
    <Card
      title={t('settings.envTitle')}
      className={SETTINGS_SCROLL_CARD_CLASS}
      styles={SETTINGS_SCROLL_CARD_STYLES}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-6">
        <Alert
          title={t('settings.envAlertDesc')}
          description={t('settings.envAlertDetail')}
          type="info"
          showIcon
        />
        {envLoading ? (
          <div className="flex justify-center py-16">
            <Spin />
          </div>
        ) : (
          <>
            <Table<EnvTableRow>
              bordered
              size="middle"
              pagination={false}
              rowKey={(r) => String(r.rowIndex)}
              dataSource={envEntries.map((entry, idx) => ({
                ...entry,
                rowIndex: idx,
              }))}
              columns={envTableColumns}
              className="[&_.ant-table-cell]:align-middle"
              locale={{
                emptyText: (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('settings.envEmpty')} />
                ),
              }}
              scroll={{ x: 'max-content' }}
            />
            <div className="flex flex-wrap items-center justify-between gap-3 border-0 border-t border-solid border-gray-200 pt-4 dark:border-gray-700">
              <Button
                type="dashed"
                icon={<PlusOutlined />}
                aria-label={t('settings.envAdd')}
                onClick={() =>
                  setEnvEntries((prev) => [...prev, { key: '', value: '', execVisible: false }])
                }
              >
                <span className="hidden sm:inline">{t('settings.envAdd')}</span>
              </Button>
              <Button
                type="primary"
                icon={<SaveOutlined />}
                loading={updateEnvMutation.isPending}
                aria-label={t('settings.envSave')}
                onClick={handleSaveEnv}
              >
                <span className="hidden sm:inline">{t('settings.envSave')}</span>
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );

  const toolsWebOn = watchedToolWebEnable !== false;
  const toolsExecOn = watchedToolExecEnable !== false;
  const toolsMyOn = watchedToolMyEnable !== false;
  const toolsMyWritable = Boolean(watchedToolMyAllowSet);
  const toolsSsrfCount = Array.isArray(watchedToolSsrfWhitelist)
    ? watchedToolSsrfWhitelist.reduce((n, x) => n + (String(x).trim() ? 1 : 0), 0)
    : 0;

  const tabItems = [
    {
      key: 'general',
      label: (
        <span className="flex items-center gap-1.5">
          <ToolOutlined /> {t('settings.tabGeneral')}
        </span>
      ),
      children: (
        <Card
          title={t('settings.agentDefaults')}
          className={SETTINGS_SCROLL_CARD_CLASS}
          styles={{
            header: SETTINGS_SCROLL_CARD_STYLES.header,
            body: {
              ...SETTINGS_SCROLL_CARD_STYLES.body,
              paddingTop: token.paddingLG,
              paddingBottom: token.paddingLG,
              paddingInline: token.paddingLG,
            },
          }}
        >
          <Text type="secondary" className="mb-6 block text-sm leading-relaxed">
            {t('settings.agentDefaultsHint')}
          </Text>
          <Form
            form={form}
            layout="vertical"
            colon={false}
            requiredMark={false}
            className="max-w-[680px]"
            labelAlign="left"
            onValuesChange={handleModelProviderLink}
          >
            <Typography.Title level={5} className="!mb-3 !mt-0 !text-base !font-semibold">
              {t('settings.sectionModelEnvironment')}
            </Typography.Title>
            <Row gutter={[token.marginLG, token.marginSM]}>
              <Col xs={24} lg={12}>
                <Form.Item
                  label={t('settings.model')}
                  name="model"
                  tooltip={{ title: t('settings.modelExtra') }}
                >
                  <AutoComplete
                    className="w-full max-w-full"
                    size="middle"
                    placeholder={t('settings.modelPh')}
                    options={modelAutocompleteOptions}
                    filterOption={(input, option) =>
                      autoCompleteFilterOption(input, option, modelAutocompleteOptions)
                    }
                  />
                </Form.Item>
              </Col>
              <Col xs={24} lg={12}>
                <Form.Item
                  label={t('settings.provider')}
                  name="provider"
                  tooltip={{ title: t('settings.providerExtra') }}
                >
                  <AutoComplete
                    className="w-full max-w-full"
                    size="middle"
                    placeholder={t('settings.providerPh')}
                    options={providerAutocompleteOptions}
                    filterOption={(input, option) =>
                      autoCompleteFilterOption(input, option, providerAutocompleteOptions)
                    }
                  />
                </Form.Item>
              </Col>
            </Row>

            <Form.Item label={t('settings.reasoningEffort')} name="reasoningEffort" className="!mb-6">
              <Segmented
                block
                size="middle"
                options={[
                  { label: t('settings.reasoningLow'), value: 'low' },
                  { label: t('settings.reasoningMedium'), value: 'medium' },
                  { label: t('settings.reasoningHigh'), value: 'high' },
                  { label: t('settings.reasoningAdaptive'), value: 'adaptive' },
                ]}
              />
            </Form.Item>

            <Form.Item
              label={t('settings.workspace')}
              name="workspace"
              tooltip={{ title: t('settings.workspaceExtra') }}
            >
              <Input
                className="font-mono text-sm"
                placeholder={t('settings.workspacePh')}
                size="middle"
              />
            </Form.Item>

            <Form.Item
              label={t('settings.timezone')}
              name="timezone"
              tooltip={{ title: t('settings.timezoneExtra') }}
            >
              <Select
                allowClear
                showSearch
                className="w-full"
                size="middle"
                placeholder={t('settings.timezonePh')}
                options={timeZoneOptions}
                optionFilterProp="value"
                popupMatchSelectWidth={false}
                listHeight={360}
              />
            </Form.Item>

            <Divider className="my-7" />

            <Typography.Title level={5} className="!mb-4 !mt-0 !text-base !font-semibold">
              {t('settings.sectionSampling')}
            </Typography.Title>

            <Row gutter={[token.marginLG, token.marginSM]}>
              <Col xs={24} sm={12}>
                <Form.Item
                  label={
                    <span>
                      {t('settings.maxTokens')}{' '}
                      <Text type="secondary" className="text-xs font-normal">
                        {t('settings.maxTokensRange')}
                      </Text>
                    </span>
                  }
                  name="maxTokens"
                >
                  <InputNumber
                    min={1}
                    max={200000}
                    size="middle"
                    className="w-full"
                  />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12}>
                <Form.Item
                  label={
                    <span>
                      {t('settings.contextWindow')}{' '}
                      <Text type="secondary" className="text-xs font-normal">
                        {t('settings.contextWindowRange')}
                      </Text>
                    </span>
                  }
                  name="contextWindowTokens"
                >
                  <InputNumber
                    min={1}
                    max={1000000}
                    size="middle"
                    className="w-full"
                  />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12}>
                <Form.Item
                  label={
                    <span>
                      {t('settings.maxHistoryMessages')}{' '}
                      <Text type="secondary" className="text-xs font-normal">
                        {t('settings.maxHistoryMessagesRange')}
                      </Text>
                    </span>
                  }
                  name="maxHistoryMessages"
                  extra={<Text type="secondary">{t('settings.maxHistoryMessagesHint')}</Text>}
                >
                  <InputNumber min={0} max={100000} size="middle" className="w-full" />
                </Form.Item>
              </Col>
            </Row>

            <Row gutter={[token.marginLG, token.marginSM]}>
              <Col xs={24}>
                <Form.Item
                  label={
                    <span>
                      {t('settings.maxIterations')}{' '}
                      <Text type="secondary" className="text-xs font-normal">
                        {t('settings.maxIterationsRange')}
                      </Text>
                    </span>
                  }
                  name="maxToolIterations"
                >
                  <Slider
                    className="w-full pt-1"
                    min={1}
                    max={200}
                    marks={{ 1: '1', 50: '50', 100: '100', 200: '200' }}
                    tooltip={{ formatter: (v) => (v !== undefined ? String(v) : '') }}
                  />
                </Form.Item>

                <Form.Item
                  label={
                    <span>
                      {t('settings.temperature')}{' '}
                      <Text type="secondary" className="text-xs font-normal">
                        {t('settings.temperatureRange')}
                      </Text>
                    </span>
                  }
                  name="temperature"
                  className="!mb-0"
                >
                  <Slider
                    className="w-full pt-1"
                    min={0}
                    max={2}
                    step={0.1}
                    marks={{ 0: '0.0', 1: '1.0', 2: '2.0' }}
                    tooltip={{ formatter: (v) => (v !== undefined ? v.toFixed(1) : '') }}
                  />
                </Form.Item>
              </Col>
            </Row>

            <Divider style={{ marginTop: token.marginXXL, marginBottom: token.marginXXL }} />

            <Collapse
              ghost
              bordered={false}
              expandIconPlacement="end"
              className="[&_.ant-collapse-header]:!px-0 [&_.ant-collapse-header]:!py-3 [&_.ant-collapse-content-box]:!px-0 [&_.ant-collapse-content-box]:!pt-0"
              items={[
                {
                  key: 'advanced',
                  label: (
                    <Typography.Text strong style={{ fontSize: token.fontSizeLG }}>
                      {t('settings.sectionAdvancedToggle')}
                    </Typography.Text>
                  ),
                  children: (
                    <Flex vertical gap={token.marginLG}>
                      <Row gutter={[token.marginLG, token.marginSM]}>
                        <Col xs={24} sm={12}>
                          <Form.Item label={t('settings.providerRetryMode')} name="providerRetryMode">
                            <Select
                              size="middle"
                              className="w-full"
                              options={[
                                { value: 'standard', label: t('settings.providerRetryStandard') },
                                { value: 'persistent', label: t('settings.providerRetryPersistent') },
                              ]}
                            />
                          </Form.Item>
                        </Col>
                        <Col xs={24} sm={12}>
                          <Form.Item label={t('settings.maxToolResultChars')} name="maxToolResultChars">
                            <InputNumber min={256} max={500000} size="middle" className="w-full" />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Row gutter={[token.marginLG, token.marginSM]}>
                        <Col xs={24} sm={12}>
                          <Form.Item
                            label={t('settings.contextBlockLimit')}
                            name="contextBlockLimit"
                            tooltip={{ title: t('settings.contextBlockLimitExtra') }}
                            normalize={(v) => (v === undefined ? null : v)}
                          >
                            <InputNumber min={1} max={2000000} size="middle" className="w-full" />
                          </Form.Item>
                        </Col>
                        <Col xs={24} sm={12}>
                          <Form.Item
                            label={t('settings.idleCompactAfterMinutes')}
                            name="idleCompactAfterMinutes"
                            tooltip={{ title: t('settings.idleCompactAfterMinutesExtra') }}
                          >
                            <InputNumber min={0} max={10080} size="middle" className="w-full" />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Form.Item label={t('settings.consolidationRatio')} name="consolidationRatio">
                        <Slider
                          className="mx-0 w-full"
                          min={0.1}
                          max={0.95}
                          step={0.05}
                          marks={{
                            0.1: '0.1',
                            0.95: '0.95',
                          }}
                          tooltip={{
                            formatter: (v) =>
                              v !== undefined ? `${Number(v).toFixed(2)}` : '',
                          }}
                        />
                      </Form.Item>
                      <Row gutter={[token.marginLG, token.marginMD]}>
                        <Col xs={24} lg={8}>
                          <Form.Item
                            label={t('settings.unifiedSession')}
                            name="unifiedSession"
                            valuePropName="checked"
                            className="!mb-0 max-lg:!mb-4"
                          >
                            <Switch />
                          </Form.Item>
                        </Col>
                        <Col xs={24} lg={8}>
                          <Form.Item
                            label={t('settings.persistSessionTranscript')}
                            name="persistSessionTranscript"
                            valuePropName="checked"
                            className="!mb-0 max-lg:!mb-4"
                          >
                            <Switch />
                          </Form.Item>
                        </Col>
                        <Col xs={24} lg={8}>
                          <Form.Item
                            label={t('settings.transcriptIncludeFullToolResults')}
                            name="transcriptIncludeFullToolResults"
                            valuePropName="checked"
                            className="!mb-0"
                          >
                            <Switch />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Form.Item label={t('settings.disabledSkillsText')} name="disabledSkills">
                        <Select
                          mode="multiple"
                          allowClear
                          showSearch
                          loading={skillCatalogLoading}
                          className="w-full"
                          placeholder={t('settings.disabledSkillsPlaceholder')}
                          options={disabledSkillSelectOptions}
                          optionFilterProp="label"
                          maxTagCount="responsive"
                          popupMatchSelectWidth={false}
                          listHeight={320}
                        />
                      </Form.Item>

                      <Divider plain titlePlacement="start" style={{ marginBottom: token.marginMD }}>
                        <Typography.Text strong>{t('settings.sectionDream')}</Typography.Text>
                      </Divider>
                      <Row gutter={[token.marginLG, token.marginSM]}>
                        <Col xs={24} sm={12}>
                          <Form.Item name={['dream', 'intervalH']} label={t('settings.dreamIntervalH')}>
                            <InputNumber min={1} max={168} size="middle" className="w-full" />
                          </Form.Item>
                        </Col>
                        <Col xs={24} sm={12}>
                          <Form.Item name={['dream', 'maxBatchSize']} label={t('settings.dreamMaxBatchSize')}>
                            <InputNumber min={1} max={500} size="middle" className="w-full" />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Row gutter={[token.marginLG, token.marginSM]}>
                        <Col xs={24} sm={12}>
                          <Form.Item name={['dream', 'maxIterations']} label={t('settings.dreamMaxIterations')}>
                            <InputNumber min={1} max={100} size="middle" className="w-full" />
                          </Form.Item>
                        </Col>
                        <Col xs={24} sm={12}>
                          <Form.Item
                            name={['dream', 'annotateLineAges']}
                            label={t('settings.dreamAnnotateLineAges')}
                            valuePropName="checked"
                          >
                            <Switch />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Form.Item
                        name={['dream', 'modelOverride']}
                        label={t('settings.dreamModelOverride')}
                        className="!mb-0"
                      >
                        <Input
                          className="font-mono text-sm"
                          placeholder={t('settings.dreamModelOverridePh')}
                          allowClear
                          size="middle"
                        />
                      </Form.Item>
                    </Flex>
                  ),
                },
              ]}
            />
          </Form>
        </Card>
      ),
    },
    {
      key: 'providers',
      label: (
        <span className="flex items-center gap-1.5">
          <KeyOutlined /> {t('settings.tabProviders')}
        </span>
      ),
      children: (
        <Card
          title={t('llmProviders.title')}
          className={SETTINGS_SCROLL_CARD_CLASS}
          styles={SETTINGS_SCROLL_CARD_STYLES}
        >
          <LLMProvidersPanel embedded />
        </Card>
      ),
    },
    {
      key: 'tools',
      label: (
        <span className="flex items-center gap-1.5">
          <CodeOutlined /> {t('settings.tabTools')}
        </span>
      ),
      children: (
        <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col gap-6 overflow-hidden">
          <Card
            title={t('settings.toolsCardTitle')}
            size="small"
            className={SETTINGS_SCROLL_CARD_CLASS}
            styles={{
              ...SETTINGS_SCROLL_CARD_STYLES,
              body: {
                ...SETTINGS_SCROLL_CARD_STYLES.body,
                paddingTop: 10,
                paddingBottom: 10,
              },
            }}
          >
            <Form form={form} layout="vertical" className="space-y-4 [&_.ant-form-item]:mb-3">
              <div className="rounded-md border border-gray-100 bg-gray-50 px-3 py-2.5 dark:border-gray-700/50 dark:bg-gray-800/50">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="mb-0.5 text-sm font-medium leading-snug">
                      {t('settings.restrictWorkspace')}
                    </p>
                    <Text type="secondary" className="text-xs leading-snug">
                      {t('settings.restrictWorkspaceDesc')}
                    </Text>
                  </div>
                  <Form.Item name="restrictToWorkspace" valuePropName="checked" className="!mb-0">
                    <Switch />
                  </Form.Item>
                </div>
              </div>

              <Collapse
                defaultActiveKey={[]}
                expandIconPlacement="end"
                className="tools-settings-collapse bg-transparent [&_.ant-collapse-item]:border-gray-200 dark:[&_.ant-collapse-item]:border-gray-700"
                items={[
                  {
                    key: 'web',
                    label: (
                      <SettingsToolsCollapsePanelLabel
                        title={t('settings.toolsWebSection')}
                        status={
                          toolsWebOn
                            ? t('settings.toolsCollapseStatusOn')
                            : t('settings.toolsCollapseStatusOff')
                        }
                        highlight={toolsWebOn}
                      />
                    ),
                    children: (
                      <div className="space-y-3 pt-1">
                        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-gray-100 bg-gray-50/80 px-3 py-2 dark:border-gray-700/50 dark:bg-gray-800/40">
                          <Text className="text-sm">{t('settings.toolsWebEnable')}</Text>
                          <Form.Item name={['toolWeb', 'enable']} valuePropName="checked" className="!mb-0">
                            <Switch />
                          </Form.Item>
                        </div>
                        <Form.Item name={['toolWeb', 'proxy']} label={t('settings.toolsWebProxy')}>
                          <Input
                            className="font-mono text-sm"
                            placeholder={t('settings.toolsWebProxyPh')}
                            allowClear
                          />
                        </Form.Item>
                        <Divider plain className="!my-2">
                          {t('settings.toolsSearchSection')}
                        </Divider>
                        <Row gutter={[token.marginLG, token.marginSM]}>
                          <Col xs={24} md={12}>
                            <Form.Item name={['toolWeb', 'search', 'provider']} label={t('settings.toolsSearchProvider')}>
                              <AutoComplete
                                className="w-full"
                                options={[...WEB_SEARCH_PROVIDER_OPTIONS]}
                                filterOption={(input, option) =>
                                  autoCompleteFilterOption(
                                    input,
                                    option,
                                    WEB_SEARCH_PROVIDER_OPTIONS,
                                  )
                                }
                                allowClear
                              >
                                <Input className="font-mono text-sm" placeholder={t('settings.toolsSearchProviderPh')} />
                              </AutoComplete>
                            </Form.Item>
                          </Col>
                          <Col xs={24} md={12}>
                            <Form.Item name={['toolWeb', 'search', 'apiKey']} label={t('settings.toolsSearchApiKey')}>
                              <Input.Password className="font-mono text-sm" placeholder={t('settings.toolsSearchApiKeyPh')} />
                            </Form.Item>
                          </Col>
                          <Col xs={24}>
                            <Form.Item name={['toolWeb', 'search', 'baseUrl']} label={t('settings.toolsSearchBaseUrl')}>
                              <Input className="font-mono text-sm" placeholder={t('settings.toolsSearchBaseUrlPh')} allowClear />
                            </Form.Item>
                          </Col>
                          <Col xs={24} sm={12}>
                            <Form.Item name={['toolWeb', 'search', 'maxResults']} label={t('settings.toolsSearchMaxResults')}>
                              <InputNumber min={1} max={50} className="w-full" />
                            </Form.Item>
                          </Col>
                          <Col xs={24} sm={12}>
                            <Form.Item name={['toolWeb', 'search', 'timeout']} label={t('settings.toolsSearchTimeout')}>
                              <InputNumber min={5} max={300} className="w-full" />
                            </Form.Item>
                          </Col>
                        </Row>
                      </div>
                    ),
                  },
                  {
                    key: 'exec',
                    label: (
                      <SettingsToolsCollapsePanelLabel
                        title={t('settings.toolsExecSection')}
                        status={
                          toolsExecOn
                            ? t('settings.toolsCollapseStatusOn')
                            : t('settings.toolsCollapseStatusOff')
                        }
                        highlight={toolsExecOn}
                      />
                    ),
                    children: (
                      <div className="space-y-3 pt-1">
                        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-gray-100 bg-gray-50/80 px-3 py-2 dark:border-gray-700/50 dark:bg-gray-800/40">
                          <Text className="text-sm">{t('settings.toolsExecEnable')}</Text>
                          <Form.Item name={['toolExec', 'enable']} valuePropName="checked" className="!mb-0">
                            <Switch />
                          </Form.Item>
                        </div>
                        <Row gutter={[token.marginLG, token.marginSM]}>
                          <Col xs={24} sm={12}>
                            <Form.Item name={['toolExec', 'timeout']} label={t('settings.toolsExecTimeout')}>
                              <InputNumber min={1} max={3600} className="w-full" />
                            </Form.Item>
                          </Col>
                          <Col xs={24} sm={12}>
                            <Form.Item name={['toolExec', 'sandbox']} label={t('settings.toolsExecSandbox')}>
                              <Input className="font-mono text-sm" placeholder={t('settings.toolsExecSandboxPh')} allowClear />
                            </Form.Item>
                          </Col>
                          <Col xs={24}>
                            <Form.Item name={['toolExec', 'pathAppend']} label={t('settings.toolsExecPathAppend')}>
                              <Input className="font-mono text-sm" placeholder={t('settings.toolsExecPathAppendPh')} allowClear />
                            </Form.Item>
                          </Col>
                          <Col xs={24}>
                            <Form.Item
                              name={['toolExec', 'allowedEnvKeys']}
                              label={t('settings.toolsExecAllowedEnvKeys')}
                              extra={t('settings.toolsExecAllowedEnvKeysExtra')}
                            >
                              <Select mode="tags" className="w-full" placeholder={t('settings.toolsExecAllowedEnvKeysPh')} tokenSeparators={[',']} />
                            </Form.Item>
                          </Col>
                        </Row>
                      </div>
                    ),
                  },
                  {
                    key: 'my',
                    label: (
                      <SettingsToolsCollapsePanelLabel
                        title={t('settings.toolsMySection')}
                        status={
                          !toolsMyOn
                            ? t('settings.toolsCollapseStatusOff')
                            : toolsMyWritable
                              ? t('settings.toolsMyCollapseStatusWritable')
                              : t('settings.toolsMyCollapseStatusReadOnly')
                        }
                        highlight={toolsMyOn}
                      />
                    ),
                    children: (
                      <div className="space-y-3 pt-1">
                        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-gray-100 bg-gray-50/80 px-3 py-2 dark:border-gray-700/50 dark:bg-gray-800/40">
                          <div className="min-w-0">
                            <Text className="text-sm">{t('settings.toolsMyEnable')}</Text>
                            <div>
                              <Text type="secondary" className="text-xs">
                                {t('settings.toolsMyEnableExtra')}
                              </Text>
                            </div>
                          </div>
                          <Form.Item name={['toolMy', 'enable']} valuePropName="checked" className="!mb-0">
                            <Switch />
                          </Form.Item>
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-gray-100 bg-gray-50/80 px-3 py-2 dark:border-gray-700/50 dark:bg-gray-800/40">
                          <div className="min-w-0">
                            <Text className="text-sm">{t('settings.toolsMyAllowSet')}</Text>
                            <div>
                              <Text type="secondary" className="text-xs">
                                {t('settings.toolsMyAllowSetExtra')}
                              </Text>
                            </div>
                          </div>
                          <Form.Item name={['toolMy', 'allowSet']} valuePropName="checked" className="!mb-0">
                            <Switch />
                          </Form.Item>
                        </div>
                      </div>
                    ),
                  },
                  {
                    key: 'ssrf',
                    label: (
                      <SettingsToolsCollapsePanelLabel
                        title={t('settings.toolsSsrfSection')}
                        status={
                          toolsSsrfCount > 0
                            ? t('settings.toolsSsrfCollapseCount', { count: toolsSsrfCount })
                            : t('settings.toolsSsrfCollapseEmpty')
                        }
                        highlight={toolsSsrfCount > 0}
                      />
                    ),
                    children: (
                      <div className="pt-1">
                        <Alert
                          type="info"
                          showIcon
                          className="mb-3"
                          title={t('settings.toolsSsrfHint')}
                        />
                        <Form.Item name="toolSsrfWhitelist" label={t('settings.toolsSsrfWhitelistLabel')}>
                          <Select mode="tags" className="w-full" placeholder={t('settings.toolsSsrfWhitelistPh')} tokenSeparators={[',']} />
                        </Form.Item>
                      </div>
                    ),
                  },
                ]}
              />
            </Form>
          </Card>
        </div>
      ),
    },
    {
      key: 'environment',
      label: (
        <span className="flex items-center gap-1.5">
          <EnvironmentOutlined /> {t('settings.tabEnvironment')}
        </span>
      ),
      children: envTabContent,
    },
  ];

  return (
    <PageLayout className="min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between pb-2">
          <header className="min-w-0">
            <h1 className={PAGE_PRIMARY_TITLE_CLASS}>{t('settings.title')}</h1>
            <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-gray-500 dark:text-gray-400">
              {t('settings.subtitle')}
            </p>
          </header>
          <Space wrap className="w-full shrink-0 justify-end sm:w-auto">
            <Button
              icon={<DownloadOutlined />}
              aria-label={t('settings.export')}
              onClick={handleExportConfig}
            >
              <span className="hidden sm:inline">{t('settings.export')}</span>
            </Button>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              loading={saveSettingsMutation.isPending}
              aria-label={t('settings.saveChanges')}
              onClick={handleSave}
            >
              <span className="hidden sm:inline">{t('settings.saveChanges')}</span>
            </Button>
          </Space>
        </div>
        <Tabs
          activeKey={activeTab}
          onChange={(key) => setActiveTab(key as SettingsTab)}
          items={tabItems}
          className="hub-shell-tabs flex min-h-0 min-w-0 flex-1 flex-col"
          size="large"
          tabBarGutter={token.marginXL}
        />
      </div>
    </PageLayout>
  );
}
