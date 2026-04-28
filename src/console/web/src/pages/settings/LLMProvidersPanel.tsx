import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  ExperimentOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import * as api from '../../api/client';
import { useAppStore } from '../../store';
import { formatQueryError } from '../../utils/errors';
import {
  ALL_FAILOVER_TRIGGERS,
  type LLMFailoverTrigger,
  type LLMProviderInstance,
  type LLMProviderInstanceCreate,
  type LLMProviderInstanceUpdate,
} from '../../api/types_llm_providers';
import ApiKeyListEditor from './ApiKeyListEditor';
import {
  draftRowsToPayload,
  emptyDraftRow,
  type ApiKeyDraftRow,
} from './apiKeyDraft';

const { Text, Paragraph } = Typography;

interface LLMProviderFormState {
  id: string;
  name: string;
  description: string;
  provider: string;
  model: string;
  apiBase: string;
  extraHeadersJson: string;
  timeoutS: number | null;
  failoverInstanceIds: string[];
  failoverOn: LLMFailoverTrigger[];
  enabled: boolean;
}

const EMPTY_FORM: LLMProviderFormState = {
  id: '',
  name: '',
  description: '',
  provider: 'custom',
  model: '',
  apiBase: '',
  extraHeadersJson: '',
  timeoutS: null,
  failoverInstanceIds: [],
  failoverOn: ['timeout', 'connection'],
  enabled: true,
};

function instanceToForm(inst: LLMProviderInstance): LLMProviderFormState {
  return {
    id: inst.id,
    name: inst.name,
    description: inst.description ?? '',
    provider: inst.provider || 'custom',
    model: inst.model ?? '',
    apiBase: inst.apiBase ?? '',
    extraHeadersJson:
      inst.extraHeaders && Object.keys(inst.extraHeaders).length > 0
        ? JSON.stringify(inst.extraHeaders, null, 2)
        : '',
    timeoutS: inst.timeoutS ?? null,
    failoverInstanceIds: inst.failoverInstanceIds ?? [],
    failoverOn: inst.failoverOn ?? ['timeout', 'connection'],
    enabled: inst.enabled,
  };
}

function formToCreatePayload(
  form: LLMProviderFormState,
  drafts: ApiKeyDraftRow[],
): LLMProviderInstanceCreate {
  return {
    id: form.id?.trim() || undefined,
    name: form.name.trim() || form.id || 'Provider',
    description: form.description.trim() || null,
    provider: form.provider.trim() || 'custom',
    model: form.model.trim() || null,
    apiKeys: draftRowsToPayload(drafts),
    apiBase: form.apiBase.trim() || null,
    extraHeaders: parseHeaders(form.extraHeadersJson),
    timeoutS: form.timeoutS ?? null,
    failoverInstanceIds: form.failoverInstanceIds,
    failoverOn: form.failoverOn,
    enabled: form.enabled,
  };
}

function formToUpdatePayload(form: LLMProviderFormState): LLMProviderInstanceUpdate {
  return {
    name: form.name.trim() || undefined,
    description: form.description.trim() || null,
    provider: form.provider.trim() || undefined,
    model: form.model.trim() || null,
    apiBase: form.apiBase.trim() || null,
    extraHeaders: parseHeaders(form.extraHeadersJson),
    timeoutS: form.timeoutS,
    failoverInstanceIds: form.failoverInstanceIds,
    failoverOn: form.failoverOn,
    enabled: form.enabled,
  };
}

function parseHeaders(json: string): Record<string, string> {
  const text = json.trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Extra headers must be a JSON object');
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      out[String(k)] = String(v);
    }
    return out;
  } catch (err) {
    throw new Error(
      `Invalid extra headers JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export default function LLMProvidersPanel({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { currentBotId, addToast } = useAppStore();
  const botId = currentBotId ?? '';

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<LLMProviderFormState>(EMPTY_FORM);
  // Plaintext-only drafts used by the create flow (cleared on close).
  const [keyDrafts, setKeyDrafts] = useState<ApiKeyDraftRow[]>([]);
  const [testing, setTesting] = useState<string | null>(null);

  const instancesQuery = useQuery({
    queryKey: ['llm-providers', botId],
    queryFn: () => api.listLLMProviders(botId),
    enabled: !!botId,
  });

  const registryQuery = useQuery({
    queryKey: ['llm-providers-registry', botId],
    queryFn: () => api.listLLMProviderRegistry(botId),
    enabled: !!botId,
  });

  const instances = useMemo(
    () => instancesQuery.data ?? [],
    [instancesQuery.data],
  );
  const registry = registryQuery.data ?? [];

  const otherInstanceOptions = useMemo(
    () =>
      instances
        .filter((inst) => inst.id !== editingId)
        .map((inst) => ({ value: inst.id, label: `${inst.name} (${inst.id})` })),
    [instances, editingId],
  );

  const createMutation = useMutation({
    mutationFn: (payload: LLMProviderInstanceCreate) => api.createLLMProvider(botId, payload),
    onSuccess: (inst) => {
      addToast({ type: 'success', message: t('llmProviders.created', { name: inst.name }) });
      setDrawerOpen(false);
      setKeyDrafts([]);
      queryClient.invalidateQueries({ queryKey: ['llm-providers', botId] });
    },
    onError: (err) => addToast({ type: 'error', message: formatQueryError(err) }),
  });

  const updateMutation = useMutation({
    mutationFn: (input: { id: string; body: LLMProviderInstanceUpdate }) =>
      api.updateLLMProvider(botId, input.id, input.body),
    onSuccess: (inst) => {
      addToast({ type: 'success', message: t('llmProviders.updated', { name: inst.name }) });
      setDrawerOpen(false);
      setKeyDrafts([]);
      queryClient.invalidateQueries({ queryKey: ['llm-providers', botId] });
    },
    onError: (err) => addToast({ type: 'error', message: formatQueryError(err) }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteLLMProvider(botId, id),
    onSuccess: () => {
      addToast({ type: 'success', message: t('llmProviders.deleted') });
      queryClient.invalidateQueries({ queryKey: ['llm-providers', botId] });
    },
    onError: (err) => addToast({ type: 'error', message: formatQueryError(err) }),
  });

  const openCreateDrawer = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    setKeyDrafts([emptyDraftRow()]);
    setDrawerOpen(true);
  };

  const openEditDrawer = (inst: LLMProviderInstance) => {
    setEditingId(inst.id);
    setForm(instanceToForm(inst));
    setKeyDrafts([]);
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    // Drop drafts immediately so plaintext keys never linger in memory
    // beyond the time the editor was open.
    setKeyDrafts([]);
  };

  const handleSubmit = () => {
    try {
      if (editingId) {
        updateMutation.mutate({ id: editingId, body: formToUpdatePayload(form) });
      } else {
        createMutation.mutate(formToCreatePayload(form, keyDrafts));
      }
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Need access to the live (cached) instance for the online key editor.
  const editingInstance = useMemo(
    () => (editingId ? instances.find((inst) => inst.id === editingId) ?? null : null),
    [editingId, instances],
  );

  const handleTest = async (inst: LLMProviderInstance) => {
    setTesting(inst.id);
    try {
      const result = await api.testLLMProvider(botId, inst.id);
      addToast({
        type: result.ok ? 'success' : 'error',
        message: result.ok
          ? t('llmProviders.testOk', {
              name: inst.name,
              ms: result.latencyMs ?? '?',
            })
          : t('llmProviders.testFail', {
              name: inst.name,
              detail: result.detail || 'Unknown error',
            }),
      });
    } catch (err) {
      addToast({ type: 'error', message: formatQueryError(err) });
    } finally {
      setTesting(null);
    }
  };

  if (!botId) {
    return <Empty description={t('llmProviders.noBot')} className="py-12" />;
  }

  if (instancesQuery.isLoading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spin />
      </div>
    );
  }

  return (
    <div className={`flex min-h-0 w-full flex-1 flex-col gap-4 ${embedded ? '' : ''}`}>
      <Alert
        type="info"
        showIcon
        message={t('llmProviders.intro')}
        description={t('llmProviders.introDesc')}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Text strong>{t('llmProviders.title')}</Text>
          <Tag color="blue">{instances.length}</Tag>
        </div>
        <Space>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => instancesQuery.refetch()}
          >
            {t('common.refresh')}
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreateDrawer}>
            {t('llmProviders.add')}
          </Button>
        </Space>
      </div>

      {instances.length === 0 ? (
        <Empty
          description={
            <span className="text-gray-500">{t('llmProviders.empty')}</span>
          }
          className="py-10"
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {instances.map((inst) => (
            <Card
              key={inst.id}
              size="small"
              className="rounded-lg border-gray-200 dark:border-gray-700"
              styles={{ body: { padding: 12 } }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Text strong className="text-base">
                      {inst.name}
                    </Text>
                    {inst.enabled ? (
                      <Tag color="success">{t('common.enabled')}</Tag>
                    ) : (
                      <Tag>{t('common.disabled')}</Tag>
                    )}
                    {inst.apiKeys.length > 0 && (
                      <Tag color={inst.apiKeys.length > 1 ? 'processing' : 'default'}>
                        {t('llmProviders.keysCount', { count: inst.apiKeys.length })}
                      </Tag>
                    )}
                    {inst.apiKeys.length === 0 && (
                      <Tag color="warning">{t('llmProviders.noKeys')}</Tag>
                    )}
                    {inst.failoverInstanceIds.length > 0 && (
                      <Tag color="warning">
                        {t('llmProviders.failoverCount', {
                          count: inst.failoverInstanceIds.length,
                        })}
                      </Tag>
                    )}
                  </div>
                  <Text type="secondary" className="block text-xs">
                    {inst.id} · {inst.provider}
                    {inst.model ? ` · ${inst.model}` : ''}
                  </Text>
                  {inst.description && (
                    <Paragraph
                      className="mb-0 mt-1 text-xs text-gray-500"
                      ellipsis={{ rows: 2 }}
                    >
                      {inst.description}
                    </Paragraph>
                  )}
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-end gap-1">
                <Tooltip title={t('llmProviders.testTip')}>
                  <Button
                    size="small"
                    icon={<ExperimentOutlined />}
                    loading={testing === inst.id}
                    onClick={() => handleTest(inst)}
                  >
                    {t('llmProviders.test')}
                  </Button>
                </Tooltip>
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => openEditDrawer(inst)}
                >
                  {t('common.edit')}
                </Button>
                <Popconfirm
                  title={t('llmProviders.confirmDelete', { name: inst.name })}
                  okText={t('common.delete')}
                  okButtonProps={{ danger: true }}
                  cancelText={t('common.cancel')}
                  onConfirm={() => deleteMutation.mutate(inst.id)}
                >
                  <Button size="small" danger icon={<DeleteOutlined />}>
                    {t('common.delete')}
                  </Button>
                </Popconfirm>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Drawer
        title={
          editingId
            ? t('llmProviders.editTitle', { name: form.name || editingId })
            : t('llmProviders.createTitle')
        }
        open={drawerOpen}
        onClose={closeDrawer}
        width={Math.min(720, typeof window !== 'undefined' ? window.innerWidth - 24 : 720)}
        destroyOnClose
        extra={
          <Space>
            <Button onClick={closeDrawer}>{t('common.cancel')}</Button>
            <Button
              type="primary"
              loading={createMutation.isPending || updateMutation.isPending}
              onClick={handleSubmit}
              icon={<CheckCircleOutlined />}
            >
              {t('common.save')}
            </Button>
          </Space>
        }
      >
        <Form layout="vertical">
          <Form.Item
            label={t('llmProviders.fieldName')}
            required
            extra={t('llmProviders.fieldNameExtra')}
          >
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={t('llmProviders.fieldNamePh')}
            />
          </Form.Item>

          <Form.Item label={t('llmProviders.fieldId')} extra={t('llmProviders.fieldIdExtra')}>
            <Input
              value={form.id}
              disabled={!!editingId}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
              placeholder={t('llmProviders.fieldIdPh')}
            />
          </Form.Item>

          <Form.Item label={t('llmProviders.fieldDescription')}>
            <Input.TextArea
              rows={2}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder={t('llmProviders.fieldDescriptionPh')}
            />
          </Form.Item>

          <Form.Item label={t('llmProviders.fieldProvider')} required>
            <Select
              value={form.provider}
              onChange={(v) => setForm({ ...form, provider: v })}
              showSearch
              optionFilterProp="label"
              options={(registry.length > 0
                ? registry
                : [{ name: 'custom', label: 'Custom' } as { name: string; label: string }]
              ).map((entry) => ({
                value: entry.name,
                label: `${entry.label} (${entry.name})`,
              }))}
            />
          </Form.Item>

          <Form.Item
            label={t('llmProviders.fieldModel')}
            extra={t('llmProviders.fieldModelExtra')}
          >
            <Input
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              placeholder={t('llmProviders.fieldModelPh')}
            />
          </Form.Item>

          <Form.Item
            label={t('llmProviders.fieldApiKeys')}
            extra={t('llmProviders.fieldApiKeysExtra')}
          >
            {editingId && editingInstance ? (
              <ApiKeyListEditor
                mode="online"
                botId={botId}
                instanceId={editingId}
                keys={editingInstance.apiKeys}
              />
            ) : (
              <ApiKeyListEditor
                mode="draft"
                drafts={keyDrafts}
                onDraftChange={setKeyDrafts}
              />
            )}
          </Form.Item>

          <Form.Item label={t('llmProviders.fieldApiBase')}>
            <Input
              value={form.apiBase}
              onChange={(e) => setForm({ ...form, apiBase: e.target.value })}
              placeholder={t('llmProviders.fieldApiBasePh')}
              className="font-mono"
            />
          </Form.Item>

          <Form.Item
            label={t('llmProviders.fieldExtraHeaders')}
            extra={t('llmProviders.fieldExtraHeadersExtra')}
          >
            <Input.TextArea
              rows={3}
              value={form.extraHeadersJson}
              onChange={(e) => setForm({ ...form, extraHeadersJson: e.target.value })}
              placeholder='{"X-Foo":"bar"}'
              className="font-mono text-xs"
            />
          </Form.Item>

          <Form.Item label={t('llmProviders.fieldTimeout')}>
            <InputNumber
              min={1}
              max={600}
              step={1}
              value={form.timeoutS ?? undefined}
              onChange={(v) =>
                setForm({ ...form, timeoutS: typeof v === 'number' ? v : null })
              }
              addonAfter="s"
              className="w-32"
            />
          </Form.Item>

          <Form.Item
            label={t('llmProviders.fieldFailoverChain')}
            extra={t('llmProviders.fieldFailoverChainExtra')}
          >
            <Select
              mode="multiple"
              value={form.failoverInstanceIds}
              onChange={(v) => setForm({ ...form, failoverInstanceIds: v })}
              options={otherInstanceOptions}
              placeholder={t('llmProviders.fieldFailoverChainPh')}
            />
          </Form.Item>

          <Form.Item
            label={t('llmProviders.fieldFailoverTriggers')}
            extra={t('llmProviders.fieldFailoverTriggersExtra')}
          >
            <Select
              mode="multiple"
              value={form.failoverOn}
              onChange={(v) =>
                setForm({ ...form, failoverOn: v as LLMFailoverTrigger[] })
              }
              options={ALL_FAILOVER_TRIGGERS.map((trigger) => ({
                value: trigger,
                label: t(`llmProviders.trigger.${trigger}`),
              }))}
            />
          </Form.Item>

          <Form.Item label={t('common.enabled')}>
            <Switch
              checked={form.enabled}
              onChange={(checked) => setForm({ ...form, enabled: checked })}
            />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  );
}
