import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Form, Input, Select, Switch, InputNumber, Tabs, Empty, Spin, Tag, Space, Button, Segmented } from 'antd';
import { useAppStore } from '../store';
import * as api from '../api/client';
import type { Agent, AgentBootstrapKey, AgentUpdateRequest } from '../api/types_agents';

const { TextArea } = Input;

const BOOTSTRAP_KEYS: AgentBootstrapKey[] = ['soul', 'user', 'agents', 'tools'];

const REASONING_OPTIONS = [
  { value: '', label: '— inherit —' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'adaptive', label: 'adaptive' },
];

const COMMON_TOOLS = [
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'glob',
  'grep',
  'exec',
  'web_search',
  'web_fetch',
  'publish_event',
  'send_to_agent',
  'send_to_agent_wait_reply',
  'reply_to_agent_request',
  'subscribe_event',
  'list_event_subscribers',
];

/**
 * Form values for the extended profile fields.
 *
 * All fields are optional and `null` means "inherit from main agent".
 * The parent component owns persistence — this panel only emits change
 * events so it can sit inside an Antd Modal alongside the legacy form.
 */
export interface AgentProfileExtras {
  max_tokens?: number | null;
  max_tool_iterations?: number | null;
  max_tool_result_chars?: number | null;
  context_window_tokens?: number | null;
  reasoning_effort?: string | null;
  timezone?: string | null;
  web_enabled?: boolean | null;
  exec_enabled?: boolean | null;
  mcp_servers_allowlist?: string[] | null;
  allowed_tools?: string[] | null;
  skills_denylist?: string[];
  use_own_bootstrap?: boolean;
  inherit_main_bootstrap?: boolean;
  /** Bind this agent to a specific LLM provider instance (id from /llm-providers). */
  provider_instance_id?: string | null;
}

interface Props {
  agent: Agent | null;
  extras: AgentProfileExtras;
  onChange: (next: AgentProfileExtras) => void;
}

/**
 * Tabbed editor for the independent persona / tool / model overrides
 * attached to one agent.
 */
export function AgentProfilePanel({ agent, extras, onChange }: Props) {
  const { t } = useTranslation();
  const { currentBotId } = useAppStore();
  const agentId = agent?.id ?? null;

  const setField = <K extends keyof AgentProfileExtras>(field: K, value: AgentProfileExtras[K]) => {
    onChange({ ...extras, [field]: value });
  };

  const items = useMemo(
    () => [
      {
        key: 'persona',
        label: t('agentProfile.tabPersona', 'Persona'),
        children: agentId ? (
          <BootstrapEditor agentId={agentId} botId={currentBotId} extras={extras} onChange={onChange} />
        ) : (
          <Empty description={t('agentProfile.saveFirstHint', 'Save the agent first to edit its persona.')} />
        ),
      },
      {
        key: 'model',
        label: t('agentProfile.tabModel', 'Model & Params'),
        children: <ModelParamsTab extras={extras} setField={setField} botId={currentBotId} />,
      },
      {
        key: 'tools',
        label: t('agentProfile.tabTools', 'Tools'),
        children: <ToolsTab extras={extras} setField={setField} />,
      },
    ],
    // setField is rebuilt every render but stable wrt extras/onChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agentId, extras, currentBotId, t, onChange],
  );

  return <Tabs defaultActiveKey="persona" items={items} className="agent-profile-tabs" />;
}

// ---------------------------------------------------------------------------
// Bootstrap editor (SOUL/USER/AGENTS/TOOLS markdown)
// ---------------------------------------------------------------------------

function BootstrapEditor({
  agentId,
  botId,
  extras,
  onChange,
}: {
  agentId: string;
  botId: string | null;
  extras: AgentProfileExtras;
  onChange: (next: AgentProfileExtras) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [active, setActive] = useState<AgentBootstrapKey>('soul');
  const [drafts, setDrafts] = useState<Record<AgentBootstrapKey, string>>({
    soul: '',
    user: '',
    agents: '',
    tools: '',
  });

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['agent-bootstrap', botId, agentId],
    queryFn: () => api.getAgentBootstrap(botId!, agentId),
    enabled: !!botId && !!agentId,
  });

  useEffect(() => {
    if (data) {
      setDrafts({
        soul: data.soul || '',
        user: data.user || '',
        agents: data.agents || '',
        tools: data.tools || '',
      });
    }
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: (input: { key: AgentBootstrapKey; content: string }) =>
      api.updateAgentBootstrap(botId!, agentId, input.key, input.content),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-bootstrap', botId, agentId] });
      queryClient.invalidateQueries({ queryKey: ['agents', botId] });
      refetch();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (key: AgentBootstrapKey) => api.deleteAgentBootstrap(botId!, agentId, key),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-bootstrap', botId, agentId] });
      queryClient.invalidateQueries({ queryKey: ['agents', botId] });
      refetch();
    },
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-6">
        <Spin />
      </div>
    );
  }

  const bootstrapFileOptions = BOOTSTRAP_KEYS.map((key) => ({
    value: key,
    label: (
      <span className="inline-flex items-center gap-1.5">
        <span>{key.toUpperCase()}.md</span>
        {drafts[key]?.trim() ? (
          <Tag color="green" className="!m-0">
            on
          </Tag>
        ) : null}
      </span>
    ),
  }));

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-gray-200/80 p-3 dark:border-gray-700/50">
        <Space size="small" wrap>
          <Switch
            checked={extras.use_own_bootstrap ?? true}
            onChange={(v) => onChange({ ...extras, use_own_bootstrap: v })}
          />
          <span className="text-sm">
            {t('agentProfile.useOwnBootstrap', 'Use this agent\u2019s own SOUL/USER/AGENTS/TOOLS')}
          </span>
        </Space>
        <div className="mt-2">
          <Space size="small" wrap>
            <Switch
              checked={extras.inherit_main_bootstrap ?? false}
              onChange={(v) => onChange({ ...extras, inherit_main_bootstrap: v })}
            />
            <span className="text-sm">
              {t(
                'agentProfile.inheritMainBootstrap',
                'Also inherit the main bot\u2019s SOUL/USER/AGENTS/TOOLS',
              )}
            </span>
          </Space>
        </div>
      </div>

      {/* Ant Design 6 Tabs items require ``children`` per pane; we only need a file switcher + one editor, so use Segmented. */}
      <Segmented
        block
        size="middle"
        value={active}
        onChange={(v) => setActive(v as AgentBootstrapKey)}
        options={bootstrapFileOptions}
        className="[&_.ant-segmented-item-label]:flex [&_.ant-segmented-item-label]:min-w-0 [&_.ant-segmented-item-label]:items-center [&_.ant-segmented-item-label]:justify-center"
      />

      <TextArea
        rows={12}
        value={drafts[active]}
        onChange={(e) => setDrafts((prev) => ({ ...prev, [active]: e.target.value }))}
        placeholder={t(
          'agentProfile.bootstrapPlaceholder',
          'Markdown content for this bootstrap file. Empty = inherit from main bot.',
        )}
        style={{ fontFamily: 'monospace' }}
      />

      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {t(
            'agentProfile.bootstrapHint',
            'Stored at workspace/agents/<id>/<NAME>.md. Removing the file falls back to main bot.',
          )}
        </span>
        <Space>
          <Button
            danger
            disabled={!drafts[active]?.trim()}
            loading={deleteMutation.isPending}
            onClick={() => {
              setDrafts((prev) => ({ ...prev, [active]: '' }));
              deleteMutation.mutate(active);
            }}
          >
            {t('agentProfile.bootstrapDelete', 'Remove')}
          </Button>
          <Button
            type="primary"
            loading={saveMutation.isPending}
            onClick={() => saveMutation.mutate({ key: active, content: drafts[active] })}
          >
            {t('agentProfile.bootstrapSave', 'Save file')}
          </Button>
        </Space>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model & params tab
// ---------------------------------------------------------------------------

function ModelParamsTab({
  extras,
  setField,
  botId,
}: {
  extras: AgentProfileExtras;
  setField: <K extends keyof AgentProfileExtras>(field: K, value: AgentProfileExtras[K]) => void;
  botId: string | null;
}) {
  const { t } = useTranslation();
  const providersQuery = useQuery({
    queryKey: ['llm-providers', botId],
    queryFn: () => api.listLLMProviders(botId!),
    enabled: !!botId,
  });
  const providerOptions = useMemo(() => {
    const rows = providersQuery.data ?? [];
    return [
      { value: '', label: t('agentProfile.providerInherit', '— inherit from main —') },
      ...rows.map((inst) => ({
        value: inst.id,
        label: `${inst.name} (${inst.provider}${inst.model ? ' · ' + inst.model : ''})`,
        title: inst.description ?? '',
      })),
    ];
  }, [providersQuery.data, t]);

  return (
    <Form layout="vertical" className="pt-2">
      <Form.Item
        label={t('agentProfile.providerInstance', 'LLM provider instance')}
        extra={t(
          'agentProfile.providerInstanceExtra',
          'Bind this agent to a configured provider (multi-key + fail-over). Falls back to main when unset.',
        )}
      >
        <Select
          showSearch
          allowClear
          optionFilterProp="label"
          value={extras.provider_instance_id ?? ''}
          onChange={(v) => setField('provider_instance_id', v ? v : null)}
          options={providerOptions}
          loading={providersQuery.isLoading}
          placeholder={t('agentProfile.providerInstancePh', 'Pick a provider instance')}
        />
      </Form.Item>
      <div className="grid grid-cols-2 gap-4">
        <Form.Item label={t('agentProfile.maxTokens', 'max_tokens (null = inherit)')}>
          <InputNumber
            className="w-full"
            min={1}
            value={extras.max_tokens ?? undefined}
            onChange={(v) => setField('max_tokens', typeof v === 'number' ? v : null)}
          />
        </Form.Item>
        <Form.Item label={t('agentProfile.maxToolIterations', 'max_tool_iterations')}>
          <InputNumber
            className="w-full"
            min={1}
            value={extras.max_tool_iterations ?? undefined}
            onChange={(v) => setField('max_tool_iterations', typeof v === 'number' ? v : null)}
          />
        </Form.Item>
        <Form.Item label={t('agentProfile.maxToolResultChars', 'max_tool_result_chars')}>
          <InputNumber
            className="w-full"
            min={256}
            value={extras.max_tool_result_chars ?? undefined}
            onChange={(v) => setField('max_tool_result_chars', typeof v === 'number' ? v : null)}
          />
        </Form.Item>
        <Form.Item label={t('agentProfile.contextWindowTokens', 'context_window_tokens')}>
          <InputNumber
            className="w-full"
            min={1024}
            value={extras.context_window_tokens ?? undefined}
            onChange={(v) => setField('context_window_tokens', typeof v === 'number' ? v : null)}
          />
        </Form.Item>
        <Form.Item label={t('agentProfile.reasoningEffort', 'reasoning_effort')}>
          <Select
            options={REASONING_OPTIONS}
            value={extras.reasoning_effort ?? ''}
            onChange={(v) => setField('reasoning_effort', v ? v : null)}
            allowClear
          />
        </Form.Item>
        <Form.Item label={t('agentProfile.timezone', 'timezone (IANA)')}>
          <Input
            placeholder="e.g. Asia/Shanghai"
            value={extras.timezone ?? ''}
            onChange={(e) => setField('timezone', e.target.value || null)}
          />
        </Form.Item>
      </div>
    </Form>
  );
}

// ---------------------------------------------------------------------------
// Tools tab
// ---------------------------------------------------------------------------

function ToolsTab({
  extras,
  setField,
}: {
  extras: AgentProfileExtras;
  setField: <K extends keyof AgentProfileExtras>(field: K, value: AgentProfileExtras[K]) => void;
}) {
  const { t } = useTranslation();
  const useWhitelist = extras.allowed_tools !== null && extras.allowed_tools !== undefined;
  return (
    <Form layout="vertical" className="pt-2">
      <div className="grid grid-cols-2 gap-4">
        <Form.Item label={t('agentProfile.webEnabled', 'web tools (null = inherit)')}>
          <Select
            value={extras.web_enabled === null || extras.web_enabled === undefined ? 'inherit' : extras.web_enabled ? 'on' : 'off'}
            options={[
              { value: 'inherit', label: '— inherit —' },
              { value: 'on', label: 'enabled' },
              { value: 'off', label: 'disabled' },
            ]}
            onChange={(v) => {
              if (v === 'inherit') setField('web_enabled', null);
              else setField('web_enabled', v === 'on');
            }}
          />
        </Form.Item>
        <Form.Item label={t('agentProfile.execEnabled', 'exec tool (null = inherit)')}>
          <Select
            value={extras.exec_enabled === null || extras.exec_enabled === undefined ? 'inherit' : extras.exec_enabled ? 'on' : 'off'}
            options={[
              { value: 'inherit', label: '— inherit —' },
              { value: 'on', label: 'enabled' },
              { value: 'off', label: 'disabled' },
            ]}
            onChange={(v) => {
              if (v === 'inherit') setField('exec_enabled', null);
              else setField('exec_enabled', v === 'on');
            }}
          />
        </Form.Item>
      </div>

      <Form.Item
        label={t('agentProfile.allowedToolsLabel', 'Tool whitelist (empty = inherit; explicit list = only these tools)')}
      >
        <div className="mb-2">
          <Switch
            checked={useWhitelist}
            onChange={(v) => setField('allowed_tools', v ? [] : null)}
          />
          <span className="ml-2 text-sm">
            {t('agentProfile.toggleWhitelist', 'Restrict to a whitelist')}
          </span>
        </div>
        {useWhitelist ? (
          <Select
            mode="tags"
            className="w-full"
            value={extras.allowed_tools ?? []}
            onChange={(v) => setField('allowed_tools', v || [])}
            options={COMMON_TOOLS.map((n) => ({ value: n, label: n }))}
            placeholder="read_file, grep, web_search …"
          />
        ) : null}
      </Form.Item>

      <Form.Item label={t('agentProfile.skillsDenylist', 'Skills to exclude (denylist)')}>
        <Select
          mode="tags"
          className="w-full"
          value={extras.skills_denylist ?? []}
          onChange={(v) => setField('skills_denylist', v || [])}
          placeholder="skill names to disable"
        />
      </Form.Item>

      <Form.Item label={t('agentProfile.mcpAllowlist', 'MCP server allowlist (empty = all)')}>
        <Select
          mode="tags"
          className="w-full"
          value={extras.mcp_servers_allowlist ?? []}
          onChange={(v) => setField('mcp_servers_allowlist', v && v.length > 0 ? v : null)}
          placeholder="server keys, e.g. notion, github"
        />
      </Form.Item>
    </Form>
  );
}

/** Pull the extras-only subset out of an :class:`Agent` record. */
export function extractExtrasFromAgent(agent: Agent | null | undefined): AgentProfileExtras {
  if (!agent) {
    return {
      max_tokens: null,
      max_tool_iterations: null,
      max_tool_result_chars: null,
      context_window_tokens: null,
      reasoning_effort: null,
      timezone: null,
      web_enabled: null,
      exec_enabled: null,
      mcp_servers_allowlist: null,
      allowed_tools: null,
      skills_denylist: [],
      use_own_bootstrap: true,
      inherit_main_bootstrap: false,
      provider_instance_id: null,
    };
  }
  return {
    max_tokens: agent.max_tokens ?? null,
    max_tool_iterations: agent.max_tool_iterations ?? null,
    max_tool_result_chars: agent.max_tool_result_chars ?? null,
    context_window_tokens: agent.context_window_tokens ?? null,
    reasoning_effort: agent.reasoning_effort ?? null,
    timezone: agent.timezone ?? null,
    web_enabled: agent.web_enabled ?? null,
    exec_enabled: agent.exec_enabled ?? null,
    mcp_servers_allowlist: agent.mcp_servers_allowlist ?? null,
    allowed_tools: agent.allowed_tools ?? null,
    skills_denylist: agent.skills_denylist ?? [],
    use_own_bootstrap: agent.use_own_bootstrap ?? true,
    inherit_main_bootstrap: agent.inherit_main_bootstrap ?? false,
    provider_instance_id: agent.provider_instance_id ?? null,
  };
}

/** Merge extras onto an :class:`AgentUpdateRequest`. */
export function applyExtrasToUpdate(
  base: AgentUpdateRequest,
  extras: AgentProfileExtras,
): AgentUpdateRequest {
  return {
    ...base,
    max_tokens: extras.max_tokens ?? null,
    max_tool_iterations: extras.max_tool_iterations ?? null,
    max_tool_result_chars: extras.max_tool_result_chars ?? null,
    context_window_tokens: extras.context_window_tokens ?? null,
    reasoning_effort: extras.reasoning_effort ?? null,
    timezone: extras.timezone ?? null,
    web_enabled: extras.web_enabled ?? null,
    exec_enabled: extras.exec_enabled ?? null,
    mcp_servers_allowlist: extras.mcp_servers_allowlist ?? null,
    allowed_tools: extras.allowed_tools ?? null,
    skills_denylist: extras.skills_denylist ?? [],
    use_own_bootstrap: extras.use_own_bootstrap ?? true,
    inherit_main_bootstrap: extras.inherit_main_bootstrap ?? false,
    provider_instance_id: extras.provider_instance_id ?? null,
  };
}
