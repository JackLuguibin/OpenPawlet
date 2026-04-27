import { useState, useEffect, useMemo, useCallback } from 'react';
import type { CSSProperties } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
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
  Radio,
  Select,
  Tag,
  Alert,
  Collapse,
  Empty,
} from 'antd';
import {
  SaveOutlined,
  DownloadOutlined,
  KeyOutlined,
  CodeOutlined,
  MobileOutlined,
  ToolOutlined,
  EnvironmentOutlined,
  PlusOutlined,
  DeleteOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons';
import * as api from '../api/client';
import { useAppStore } from '../store';
import { formatQueryError } from '../utils/errors';
import { getCommonTimeZoneSelectOptions } from '../utils/timezones';
import { PageLayout } from '../components/PageLayout';
import {
  PROVIDER_NAMES,
  type ProviderFormEntry,
  buildProvidersPayload,
  providerDisplayName,
} from './settings/providersUtils';
import Channels from './Channels';
import Cron from './Cron';

const { Text } = Typography;

/** Shared card chrome (border, radius). */
const SETTINGS_CARD_SURFACE =
  'w-full rounded-md shadow-sm border border-gray-200/80 dark:border-gray-700/80';

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
  | 'channels'
  | 'cron'
  | 'environment';

interface FormData {
  workspace: string;
  model: string;
  provider: string;
  timezone: string;
  max_tokens: number;
  context_window_tokens: number;
  max_iterations: number;
  temperature: number;
  reasoning_effort: string;
  restrict_to_workspace: boolean;
}

const VALID_SETTINGS_TABS: ReadonlyArray<SettingsTab> = [
  'general',
  'providers',
  'tools',
  'channels',
  'cron',
  'environment',
];

function readSettingsTab(searchParams: URLSearchParams): SettingsTab {
  const raw = searchParams.get('tab') as SettingsTab | null;
  return raw && VALID_SETTINGS_TABS.includes(raw) ? raw : 'general';
}

export default function Settings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { addToast, currentBotId } = useAppStore();
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
  const [form] = Form.useForm<FormData>();
  const { data: config, isLoading } = useQuery({
    queryKey: ['config', currentBotId],
    queryFn: () => api.getConfig(currentBotId),
  });

  const { data: status } = useQuery({
    queryKey: ['status', currentBotId],
    queryFn: () => api.getStatus(currentBotId),
  });

  const { data: envData, isLoading: envLoading } = useQuery({
    queryKey: ['env', currentBotId],
    queryFn: () => api.getEnv(currentBotId),
  });

  const timeZoneOptions = useMemo(() => {
    const base = getCommonTimeZoneSelectOptions();
    const agents = (config as Record<string, unknown> | undefined)?.agents as
      | Record<string, unknown>
      | undefined;
    const defaults = agents?.defaults as Record<string, unknown> | undefined;
    const rawTz = defaults?.timezone;
    const tz = typeof rawTz === 'string' ? rawTz.trim() : '';
    if (tz && !base.some((o) => o.value === tz)) {
      return [{ label: tz, value: tz }, ...base];
    }
    return base;
  }, [config]);

  const [envEntries, setEnvEntries] = useState<Array<{ key: string; value: string }>>([]);
  useEffect(() => {
    if (envData?.vars) {
      setEnvEntries(
        Object.entries(envData.vars).map(([key, value]) => ({ key, value }))
      );
    } else if (envData && Object.keys(envData.vars || {}).length === 0) {
      setEnvEntries([]);
    }
  }, [envData]);

  const [providerForm, setProviderForm] = useState<Record<string, ProviderFormEntry>>({});
  const [providerFilter, setProviderFilter] = useState('');
  const filteredProviderNames = useMemo(() => {
    const q = providerFilter.trim().toLowerCase();
    if (!q) return [...PROVIDER_NAMES];
    return PROVIDER_NAMES.filter(
      (name) =>
        name.toLowerCase().includes(q) ||
        providerDisplayName(name, t).toLowerCase().includes(q)
    );
  }, [providerFilter, t]);

  useEffect(() => {
    const raw = (config as Record<string, unknown>)?.providers as Record<string, Record<string, unknown>> | undefined;
    if (!raw) {
      const empty: ProviderFormEntry = { apiKey: '', apiBase: '', extraHeadersJson: '' };
      setProviderForm(Object.fromEntries(PROVIDER_NAMES.map((name) => [name, empty])));
      return;
    }
    const next: Record<string, ProviderFormEntry> = {};
    for (const name of PROVIDER_NAMES) {
      const p = raw[name] ?? raw[name.replace(/_/g, '')] ?? {};
      const apiKey = (p.apiKey ?? p.api_key ?? '') as string;
      const apiBase = (p.apiBase ?? p.api_base ?? '') as string;
      const extra = p.extraHeaders ?? p.extra_headers;
      const extraHeadersJson =
        typeof extra === 'object' && extra !== null
          ? JSON.stringify(extra, null, 2)
          : typeof extra === 'string'
            ? extra
            : '';
      next[name] = { apiKey, apiBase, extraHeadersJson };
    }
    setProviderForm(next);
  }, [config]);

  useEffect(() => {
    if (config) {
      const agents = (config as Record<string, unknown>).agents as Record<string, unknown> | undefined;
      const tools = (config as Record<string, unknown>).tools as Record<string, unknown> | undefined;
      const defaults = agents?.defaults as Record<string, unknown> | undefined;
      // 后端返回 camelCase (model_dump by_alias)，兼容 snake_case
      const raw = (key: string, camel: string, fallback: number | string) => {
        const d = defaults ?? {};
        return (d[key] ?? d[camel] ?? fallback) as number | string;
      };

      form.setFieldsValue({
        workspace: (defaults?.workspace as string) ?? '~/.nanobot/workspace',
        model: (defaults?.model as string) ?? '',
        provider: (defaults?.provider as string) ?? 'auto',
        timezone: (raw('timezone', 'timezone', 'UTC') as string) || 'UTC',
        max_tokens: Number(raw('maxTokens', 'max_tokens', 8192)),
        context_window_tokens: Number(raw('contextWindowTokens', 'context_window_tokens', 65536)),
        max_iterations: Number(raw('maxToolIterations', 'max_tool_iterations', 40)),
        temperature: Number(raw('temperature', 'temperature', 0.1)),
        reasoning_effort: (raw('reasoningEffort', 'reasoning_effort', 'medium') as string) || 'medium',
        restrict_to_workspace: (tools?.restrictToWorkspace as boolean) || false,
      });
    }
  }, [config, form]);

  const saveSettingsMutation = useMutation({
    mutationFn: async () => {
      const values = await form.validateFields();
      const providersPayload = buildProvidersPayload(providerForm);
      await api.updateConfig(
        'agents',
        {
          defaults: {
            workspace: values.workspace?.trim() || undefined,
            model: values.model?.trim() || undefined,
            provider: values.provider?.trim() || undefined,
            timezone: (values.timezone ?? '').trim() || 'UTC',
            max_tokens: values.max_tokens,
            context_window_tokens: values.context_window_tokens,
            max_tool_iterations: values.max_iterations,
            temperature: values.temperature,
            reasoning_effort: values.reasoning_effort,
          },
        },
        currentBotId
      );
      await api.updateConfig('providers', providersPayload, currentBotId);
      await api.updateConfig(
        'tools',
        { restrictToWorkspace: values.restrict_to_workspace },
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
    mutationFn: (vars: Record<string, string>) => api.updateEnv(vars, currentBotId),
    onSuccess: () => {
      addToast({
        type: 'success',
        message: t('settings.envSaved'),
      });
      queryClient.invalidateQueries({ queryKey: ['env'] });
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
    for (const { key, value } of envEntries) {
      const k = key?.trim();
      if (k) vars[k] = value ?? '';
    }
    updateEnvMutation.mutate(vars);
  };

  const setProviderField = (
    name: string,
    field: keyof ProviderFormEntry,
    value: string
  ) => {
    setProviderForm((prev) => ({
      ...prev,
      [name]: { ...(prev[name] ?? { apiKey: '', apiBase: '', extraHeadersJson: '' }), [field]: value },
    }));
  };

  const handleExportConfig = () => {
    const configStr = JSON.stringify(config, null, 2);
    const blob = new Blob([configStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'nanobot-config.json';
    a.click();
    URL.revokeObjectURL(url);
    addToast({ type: 'success', message: t('settings.exported') });
  };

  const configRaw = config as Record<string, unknown> | undefined;
  const mcpServers = (configRaw?.tools as Record<string, unknown>)?.mcpServers as
    | Record<string, unknown>
    | undefined;

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
      <Alert
        title={t('settings.envAlertTitle')}
        description={`${t('settings.envAlertDesc')} ${t('settings.envAlertDetail')}`}
        type="info"
        showIcon
        className="mb-4"
      />
      {envLoading ? (
        <Spin />
      ) : (
        <>
          <div className="space-y-2">
            {envEntries.map((entry, idx) => (
              <div key={idx} className="flex gap-2 items-center">
                <Input
                  placeholder={t('settings.envKeyPh')}
                  value={entry.key}
                  onChange={(e) => {
                    const next = [...envEntries];
                    next[idx] = { ...next[idx], key: e.target.value };
                    setEnvEntries(next);
                  }}
                  className="flex-1 font-mono"
                />
                <Input.Password
                  placeholder={t('settings.envValuePh')}
                  value={entry.value}
                  onChange={(e) => {
                    const next = [...envEntries];
                    next[idx] = { ...next[idx], value: e.target.value };
                    setEnvEntries(next);
                  }}
                  className="flex-1 font-mono"
                />
                <Button
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => setEnvEntries(envEntries.filter((_, i) => i !== idx))}
                />
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Button
              icon={<PlusOutlined />}
              onClick={() => setEnvEntries([...envEntries, { key: '', value: '' }])}
            >
              {t('settings.envAdd')}
            </Button>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              loading={updateEnvMutation.isPending}
              onClick={handleSaveEnv}
            >
              {t('settings.envSave')}
            </Button>
          </div>
        </>
      )}
    </Card>
  );

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
            body: { ...SETTINGS_SCROLL_CARD_STYLES.body, paddingTop: 4 },
          }}
        >
          <Form form={form} layout="vertical" className="w-full">
            <Form.Item
              label={t('settings.model')}
              name="model"
              extra={t('settings.modelExtra')}
            >
              <AutoComplete
                className="w-full"
                size="large"
                placeholder={t('settings.modelPh')}
                options={[
                  ...(status?.model ? [{ value: status.model }] : []),
                  { value: 'anthropic/claude-opus-4-5' },
                  { value: 'openai/gpt-4o' },
                  { value: 'deepseek-v3.2' },
                  { value: 'deepseek/deepseek-chat' },
                  { value: 'openrouter/openai/gpt-4o' },
                ].filter((o, i, arr) => arr.findIndex((x) => x.value === o.value) === i)}
                filterOption={(input, option) =>
                  (option?.value ?? '').toLowerCase().includes((input || '').toLowerCase())
                }
              />
            </Form.Item>

            <Form.Item
              label={t('settings.provider')}
              name="provider"
              extra={t('settings.providerExtra')}
            >
              <AutoComplete
                className="w-full"
                size="large"
                placeholder={t('settings.providerPh')}
                options={[
                  { value: 'auto' },
                  ...PROVIDER_NAMES.map((p) => ({ value: p })),
                ].filter((o, i, arr) => arr.findIndex((x) => x.value === o.value) === i)}
                filterOption={(input, option) =>
                  (option?.value ?? '').toLowerCase().includes((input || '').toLowerCase())
                }
              />
            </Form.Item>

            <Form.Item label={t('settings.reasoningEffort')} name="reasoning_effort">
              <Radio.Group
                buttonStyle="solid"
                size="large"
                className="flex w-full [&_.ant-radio-button-wrapper]:flex-1 [&_.ant-radio-button-wrapper]:text-center"
              >
                <Radio.Button value="low">{t('settings.reasoningLow')}</Radio.Button>
                <Radio.Button value="medium">{t('settings.reasoningMedium')}</Radio.Button>
                <Radio.Button value="high">{t('settings.reasoningHigh')}</Radio.Button>
              </Radio.Group>
            </Form.Item>

            <Form.Item
              label={t('settings.workspace')}
              name="workspace"
              extra={t('settings.workspaceExtra')}
            >
              <Input className="w-full" placeholder={t('settings.workspacePh')} size="large" />
            </Form.Item>

            <Form.Item
              label={t('settings.timezone')}
              name="timezone"
              extra={t('settings.timezoneExtra')}
            >
              <Select
                allowClear
                showSearch
                className="w-full"
                size="large"
                placeholder={t('settings.timezonePh')}
                options={timeZoneOptions}
                optionFilterProp="value"
                popupMatchSelectWidth={false}
                listHeight={360}
              />
            </Form.Item>

            <Form.Item
              label={
                <span>
                  {t('settings.maxTokens')}{' '}
                  <Text type="secondary" className="text-xs font-normal">
                    {t('settings.maxTokensRange')}
                  </Text>
                </span>
              }
              name="max_tokens"
            >
              <InputNumber min={1} max={200000} className="w-full" size="large" />
            </Form.Item>

            <Form.Item
              label={
                <span>
                  {t('settings.contextWindow')}{' '}
                  <Text type="secondary" className="text-xs font-normal">
                    {t('settings.contextWindowRange')}
                  </Text>
                </span>
              }
              name="context_window_tokens"
            >
              <InputNumber min={1} max={1000000} className="w-full" size="large" />
            </Form.Item>

            <Form.Item
              label={
                <span>
                  {t('settings.maxIterations')}{' '}
                  <Text type="secondary" className="text-xs font-normal">
                    {t('settings.maxIterationsRange')}
                  </Text>
                </span>
              }
              name="max_iterations"
            >
              <Slider min={1} max={100} marks={{ 1: '1', 50: '50', 100: '100' }} tooltip={{ formatter: (v) => (v !== undefined ? v : '') }} />
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
            >
              <Slider
                min={0}
                max={2}
                step={0.1}
                marks={{ 0: '0.0', 1: '1.0', 2: '2.0' }}
                tooltip={{ formatter: (v) => (v !== undefined ? v.toFixed(1) : '') }}
              />
            </Form.Item>
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
        <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col gap-4">
          <Card
            title={t('settings.providersCardTitle')}
            className={SETTINGS_SCROLL_CARD_CLASS}
            styles={{
              header: SETTINGS_SCROLL_CARD_STYLES.header,
              body: { ...SETTINGS_SCROLL_CARD_STYLES.body, paddingTop: 12 },
            }}
            extra={
              <Input.Search
                allowClear
                placeholder={t('settings.searchProviders')}
                value={providerFilter}
                onChange={(e) => setProviderFilter(e.target.value)}
                className="w-[min(100%,11rem)] sm:w-52"
                size="middle"
              />
            }
          >
            <Alert
              title={t('settings.providersWarnTitle')}
              description={t('settings.providersWarnDesc')}
              type="warning"
              showIcon
              className="mb-4"
            />
            {filteredProviderNames.length === 0 ? (
              <Empty className="py-6" description={t('settings.noMatchingProviders')} />
            ) : (
              <div className="pr-0.5">
                <Collapse
                  defaultActiveKey={[]}
                  expandIconPlacement="end"
                  className="bg-transparent"
                  items={filteredProviderNames.map((name) => {
                    const entry = providerForm[name] ?? {
                      apiKey: '',
                      apiBase: '',
                      extraHeadersJson: '',
                    };
                    const hasKey = Boolean(entry.apiKey?.trim());
                    return {
                      key: name,
                      label: (
                        <span className="flex min-w-0 flex-1 items-center gap-2">
                          <span className="truncate font-medium text-gray-900 dark:text-gray-100">
                            {providerDisplayName(name, t)}
                          </span>
                          {hasKey && (
                            <Tag color="success" className="m-0 shrink-0">
                              {t('common.configured')}
                            </Tag>
                          )}
                        </span>
                      ),
                      children: (
                        <div className="grid grid-cols-1 gap-4">
                          <div>
                            <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                              {t('settings.apiKey')}
                            </label>
                            <Input.Password
                              placeholder={t('settings.apiKeyPh')}
                              value={entry.apiKey}
                              onChange={(e) => setProviderField(name, 'apiKey', e.target.value)}
                              className="font-mono"
                              size="large"
                            />
                          </div>
                          <div>
                            <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                              {t('settings.apiBase')}
                            </label>
                            <Input
                              placeholder={t('settings.apiBasePh')}
                              value={entry.apiBase}
                              onChange={(e) => setProviderField(name, 'apiBase', e.target.value)}
                              className="font-mono"
                              size="large"
                            />
                          </div>
                          <div>
                            <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                              {t('settings.extraHeaders')}
                            </label>
                            <Input.TextArea
                              placeholder={t('settings.extraHeadersPh')}
                              value={entry.extraHeadersJson}
                              onChange={(e) =>
                                setProviderField(name, 'extraHeadersJson', e.target.value)
                              }
                              rows={3}
                              className="font-mono text-sm"
                            />
                          </div>
                        </div>
                      ),
                    };
                  })}
                />
              </div>
            )}
          </Card>
        </div>
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
        <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col gap-6">
          <Card
            title={t('settings.toolsCardTitle')}
            size="small"
            className={`${SETTINGS_CARD_SURFACE} shrink-0`}
            styles={{ body: { paddingTop: 10, paddingBottom: 10 } }}
          >
            <Form form={form} layout="vertical" className="[&_.ant-form-item]:mb-0">
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
                  <Form.Item name="restrict_to_workspace" valuePropName="checked" className="!mb-0">
                    <Switch />
                  </Form.Item>
                </div>
              </div>
            </Form>
          </Card>

          <Card
            title={t('settings.mcpConfiguredTitle')}
            size="small"
            className={SETTINGS_SCROLL_CARD_CLASS}
            styles={SETTINGS_SCROLL_CARD_STYLES}
          >
          <div className="pt-1">
            {mcpServers && Object.keys(mcpServers).length > 0 ? (
              <div className="space-y-2">
                {Object.entries(mcpServers).map(([name, serverConfig]) => {
                  const sc = serverConfig as Record<string, unknown>;
                  return (
                    <Card key={name} size="small" className="min-w-0 w-full">
                      <div className="flex min-w-0 items-center gap-3">
                        <CodeOutlined className="shrink-0 text-gray-500" />
                        <div className="min-w-0">
                          <p className="font-medium">{name}</p>
                          <Text
                            type="secondary"
                            className="break-words font-mono text-xs [overflow-wrap:anywhere]"
                          >
                            {sc.command
                              ? `${sc.command} ${Array.isArray(sc.args) ? (sc.args as string[]).join(' ') : ''}`
                              : String(sc.url || '')}
                          </Text>
                        </div>
                      </div>
                    </Card>
                  );
                })}
              </div>
            ) : (
              <Alert
                title={t('settings.mcpNoneTitle')}
                description={
                  <span>
                    {t('settings.mcpNoneDesc')}{' '}
                    <code className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-xs font-mono">
                      tools.mcpServers
                    </code>
                  </span>
                }
                type="info"
                showIcon
              />
            )}
          </div>
          </Card>
        </div>
      ),
    },
    {
      key: 'channels',
      label: (
        <span className="flex items-center gap-1.5">
          <MobileOutlined /> {t('settings.tabChannels')}
        </span>
      ),
      children: (
        <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden">
          <Channels embedded />
        </div>
      ),
    },
    {
      key: 'cron',
      label: (
        <span className="flex items-center gap-1.5">
          <ClockCircleOutlined /> {t('settings.tabCron')}
        </span>
      ),
      children: (
        <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden">
          <Cron embedded />
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
    <PageLayout variant="bleed" className="gap-6 md:p-8">
      {/* Header */}
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-4 border-b border-slate-200/90 pb-6 dark:border-slate-700/70">
        <div className="min-w-0 space-y-0.5">
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-white">
            {t('settings.title')}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('settings.subtitle')}
          </p>
        </div>
        <Space wrap className="shrink-0">
          <Button icon={<DownloadOutlined />} onClick={handleExportConfig}>
            {t('settings.export')}
          </Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            loading={saveSettingsMutation.isPending}
            onClick={handleSave}
          >
            {t('settings.saveChanges')}
          </Button>
        </Space>
      </div>

      <Tabs
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as SettingsTab)}
        items={tabItems}
        className="hub-shell-tabs"
      />
    </PageLayout>
  );
}
