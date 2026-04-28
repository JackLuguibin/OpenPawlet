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
  theme,
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
import { PROVIDER_NAMES } from './settings/providersUtils';
import LLMProvidersPanel from './settings/LLMProvidersPanel';

const { Text } = Typography;

/** Shared card chrome (border, radius). Flat, line-only surface. */
const SETTINGS_CARD_SURFACE =
  'w-full rounded border border-gray-200 dark:border-gray-800 shadow-none';

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
  'environment',
];

function readSettingsTab(searchParams: URLSearchParams): SettingsTab {
  const raw = searchParams.get('tab') as SettingsTab | null;
  return raw && VALID_SETTINGS_TABS.includes(raw) ? raw : 'general';
}

export default function Settings() {
  const { token } = theme.useToken();
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
      const agents = (config as Record<string, unknown>).agents as Record<string, unknown> | undefined;
      const tools = (config as Record<string, unknown>).tools as Record<string, unknown> | undefined;
      const defaults = agents?.defaults as Record<string, unknown> | undefined;
      // 后端返回 camelCase (model_dump by_alias)，兼容 snake_case
      const raw = (key: string, camel: string, fallback: number | string) => {
        const d = defaults ?? {};
        return (d[key] ?? d[camel] ?? fallback) as number | string;
      };

      form.setFieldsValue({
        workspace: (defaults?.workspace as string) ?? '~/.openpawlet/workspace',
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
      <div className="flex min-h-0 flex-1 flex-col gap-6">
        <Alert
          message={t('settings.envAlertDesc')}
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
                onClick={() =>
                  setEnvEntries((prev) => [...prev, { key: '', value: '', execVisible: false }])
                }
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
      </div>
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
                    options={[
                      { value: 'auto' },
                      ...PROVIDER_NAMES.map((p) => ({ value: p })),
                    ].filter((o, i, arr) => arr.findIndex((x) => x.value === o.value) === i)}
                    filterOption={(input, option) =>
                      (option?.value ?? '').toLowerCase().includes((input || '').toLowerCase())
                    }
                  />
                </Form.Item>
              </Col>
            </Row>

            <Form.Item label={t('settings.reasoningEffort')} name="reasoning_effort" className="!mb-6">
              <Segmented
                block
                size="middle"
                options={[
                  { label: t('settings.reasoningLow'), value: 'low' },
                  { label: t('settings.reasoningMedium'), value: 'medium' },
                  { label: t('settings.reasoningHigh'), value: 'high' },
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
                  name="max_tokens"
                >
                  <InputNumber
                    min={1}
                    max={200000}
                    size="middle"
                    className="!w-full max-w-[220px]"
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
                  name="context_window_tokens"
                >
                  <InputNumber
                    min={1}
                    max={1000000}
                    size="middle"
                    className="!w-full max-w-[220px]"
                  />
                </Form.Item>
              </Col>
            </Row>

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
              <div className="max-w-xl pt-1">
                <Slider
                  min={1}
                  max={100}
                  marks={{ 1: '1', 50: '50', 100: '100' }}
                  tooltip={{ formatter: (v) => (v !== undefined ? String(v) : '') }}
                />
              </div>
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
              <div className="max-w-xl pt-1">
                <Slider
                  min={0}
                  max={2}
                  step={0.1}
                  marks={{ 0: '0.0', 1: '1.0', 2: '2.0' }}
                  tooltip={{ formatter: (v) => (v !== undefined ? v.toFixed(1) : '') }}
                />
              </div>
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
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-0.5">
          <h1 className={PAGE_PRIMARY_TITLE_CLASS}>
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
        size="large"
        tabBarGutter={token.margin}
      />
    </PageLayout>
  );
}
