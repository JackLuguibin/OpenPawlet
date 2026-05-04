import { useState, useMemo, useRef, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Modal,
  Input,
  InputNumber,
  Form,
  Select,
  Tooltip,
  Empty,
  Popconfirm,
  Spin,
  Space,
  Divider,
  Typography,
  Checkbox,
  Upload,
  Switch,
  Collapse,
  Row,
  Col,
  Tag,
} from 'antd';
import { AgentProfilePanel, type AgentProfilePanelHandle } from '../components/AgentProfilePanel';
import {
  applyExtrasToUpdate,
  extractExtrasFromAgent,
  type AgentProfileExtras,
} from '../components/agentProfileExtras';
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  ReloadOutlined,
  UploadOutlined,
  DownloadOutlined,
  EyeInvisibleOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAppStore } from '../store';
import { PageLayout } from '../components/PageLayout';
import { PAGE_PRIMARY_TITLE_GRADIENT_CLASS } from '../utils/pageTitleClasses';
import * as api from '../api/client';
import { useAgentTimeZone } from '../hooks/useAgentTimeZone';
import { formatAgentDateISO } from '../utils/agentDatetime';
import type { Agent, AgentCreateRequest, AgentUpdateRequest } from '../api/types_agents';
import {
  BUILTIN_CATEGORY_META,
  TOPIC_RECOMMENDATIONS,
  TOPIC_MAX_COUNT,
  normalizeTopics,
  resolveAgentCategory,
} from './agents/agentsUtils';

const MAIN_GATEWAY_AGENT_ID = 'main' as const;

function isMainGatewayAgent(agent: Pick<Agent, 'id'>): boolean {
  return agent.id === MAIN_GATEWAY_AGENT_ID;
}

const { TextArea } = Input;

/** Shared modal layout for agent create/edit forms (scroll + viewport sizing). */
const AGENT_FORM_MODAL_STYLES = {
  header: { marginBottom: 0 },
  body: {
    paddingTop: 8,
    maxHeight: 'min(560px, calc(100vh - 160px))',
    overflowY: 'auto' as const,
    overflowX: 'hidden' as const,
  },
};

type CategoryDef = { key: string; label: string; color: string };

export default function Agents({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { currentBotId, addToast } = useAppStore();
  const agentTz = useAgentTimeZone();
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [addCategoryModalOpen, setAddCategoryModalOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [topicIssues, setTopicIssues] = useState<{
    invalidFormat: string[];
    tooLong: string[];
    overflowed: boolean;
  }>({
    invalidFormat: [],
    tooLong: [],
    overflowed: false,
  });
  const [createFormCategory, setCreateFormCategory] = useState('general');
  const [editFormCategory, setEditFormCategory] = useState('general');
  const [editExtras, setEditExtras] = useState<AgentProfileExtras>(() =>
    extractExtrasFromAgent(null),
  );
  const [createExtras, setCreateExtras] = useState<AgentProfileExtras>(() =>
    extractExtrasFromAgent(null),
  );
  const agentProfilePanelRef = useRef<AgentProfilePanelHandle>(null);

  const llmProvidersQuery = useQuery({
    queryKey: ['llm-providers', currentBotId],
    queryFn: () => api.listLLMProviders(currentBotId!),
    enabled: !!currentBotId,
  });
  const llmProviderOptions = useMemo(() => {
    const rows = llmProvidersQuery.data ?? [];
    return [
      { value: '', label: t('agentProfile.providerInherit', '— inherit from main —') },
      ...rows.map((inst) => ({
        value: inst.id,
        label: `${inst.name} (${inst.provider}${inst.model ? ' · ' + inst.model : ''})`,
        title: inst.description ?? '',
      })),
    ];
  }, [llmProvidersQuery.data, t]);
  const [formData, setFormData] = useState<AgentCreateRequest>({
    name: '',
    description: '',
    model: null,
    temperature: null,
    system_prompt: '',
    skills: [],
    topics: [],
    collaborators: [],
    enabled: true,
  });

  const { data: agents = [], isLoading, error, refetch } = useQuery({
    queryKey: ['agents', currentBotId],
    queryFn: () => api.listAgents(currentBotId!),
    enabled: !!currentBotId,
  });

  const { data: botStatus } = useQuery({
    queryKey: ['status', currentBotId],
    queryFn: () => api.getStatus(currentBotId!),
    enabled: !!currentBotId,
  });

  const { data: skillsList } = useQuery({
    queryKey: ['skills', currentBotId],
    queryFn: () => api.listSkills(currentBotId),
    enabled: !!currentBotId,
  });

  // Custom categories from API
  const { data: customCategories = [], refetch: refetchCategories } = useQuery({
    queryKey: ['agent-categories', currentBotId],
    queryFn: () => api.listCategories(currentBotId!),
    enabled: !!currentBotId,
  });

  // Category overrides from API
  const { data: categoryOverrides = {} } = useQuery({
    queryKey: ['agent-category-overrides', currentBotId],
    queryFn: () => api.getCategoryOverrides(currentBotId!),
    enabled: !!currentBotId,
  });

  const builtinCategories = useMemo<CategoryDef[]>(
    () =>
      BUILTIN_CATEGORY_META.map((c) => ({
        ...c,
        label: t(`agents.builtIn.${c.key}`),
      })),
    [t],
  );

  const allCategoryTabs = useMemo(
    () => [...builtinCategories, ...customCategories],
    [builtinCategories, customCategories],
  );

  const selectableCategories = useMemo(
    () => allCategoryTabs.filter((c) => c.key !== 'all'),
    [allCategoryTabs],
  );

  // Filter agents by category
  const filteredAgents = useMemo(() => {
    if (selectedCategory === 'all') return agents;
    return agents.filter(
      (agent) => resolveAgentCategory(agent, categoryOverrides) === selectedCategory,
    );
  }, [agents, selectedCategory, categoryOverrides]);

  const batchSelectableAgents = useMemo(
    () => filteredAgents.filter((a) => !isMainGatewayAgent(a)),
    [filteredAgents],
  );

  const addCategoryMutation = useMutation({
    mutationFn: (label: string) => api.addCategory(currentBotId!, label),
    onSuccess: (cat) => {
      refetchCategories();
      setSelectedCategory(cat.key);
      setNewCategoryName('');
      setAddCategoryModalOpen(false);
      addToast({ type: 'success', message: t('agents.categoryAdded', { name: cat.label }) });
    },
    onError: (err: Error) => {
      addToast({ type: 'error', message: t('agents.categoryAddFailed', { error: err.message }) });
    },
  });

  const createMutation = useMutation({
    mutationFn: async (input: {
      payload: AgentCreateRequest;
      displayCategory: string;
      extras?: AgentProfileExtras;
    }) => {
      const enrichedPayload: AgentCreateRequest = input.extras
        ? { ...input.payload, provider_instance_id: input.extras.provider_instance_id ?? null }
        : input.payload;
      const agent = await api.createAgent(currentBotId!, enrichedPayload);
      await api.setCategoryOverride(
        currentBotId!,
        agent.id,
        input.displayCategory
      );
      return agent;
    },
    onSuccess: (agent) => {
      queryClient.invalidateQueries({ queryKey: ['agents', currentBotId] });
      queryClient.invalidateQueries({ queryKey: ['agents-status', currentBotId] });
      queryClient.invalidateQueries({ queryKey: ['agent-category-overrides', currentBotId] });
      addToast({ type: 'success', message: t('agents.created', { name: agent.name }) });
      setCreateModalOpen(false);
      resetForm();
    },
    onError: (err: Error) => {
      addToast({ type: 'error', message: t('agents.createFailed', { error: err.message }) });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (input: {
      agentId: string;
      data: AgentUpdateRequest;
      displayCategory: string;
    }) => {
      const agent = await api.updateAgent(
        currentBotId!,
        input.agentId,
        input.data
      );
      await api.setCategoryOverride(
        currentBotId!,
        input.agentId,
        input.displayCategory
      );
      return agent;
    },
    onSuccess: (agent) => {
      queryClient.invalidateQueries({ queryKey: ['agents', currentBotId] });
      queryClient.invalidateQueries({ queryKey: ['agent-category-overrides', currentBotId] });
      addToast({ type: 'success', message: t('agents.updated', { name: agent.name }) });
      setEditModalOpen(false);
      setSelectedAgent(null);
    },
    onError: (err: Error) => {
      addToast({ type: 'error', message: t('agents.updateFailed', { error: err.message }) });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (agentId: string) => api.deleteAgent(currentBotId!, agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents', currentBotId] });
      queryClient.invalidateQueries({ queryKey: ['agents-status', currentBotId] });
      addToast({ type: 'success', message: t('agents.deleted') });
    },
    onError: (err: Error) => {
      addToast({ type: 'error', message: t('agents.deleteFailed', { error: err.message }) });
    },
  });

  const disableMutation = useMutation({
    mutationFn: (agentId: string) => api.disableAgent(currentBotId!, agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents', currentBotId] });
      queryClient.invalidateQueries({ queryKey: ['agents-status', currentBotId] });
      addToast({ type: 'success', message: t('agents.disabled') });
    },
    onError: (err: Error) => {
      addToast({ type: 'error', message: t('agents.disableFailed', { error: err.message }) });
    },
  });

  const resetForm = () => {
    setFormData({
      name: '',
      description: '',
      model: null,
      temperature: null,
      system_prompt: '',
      skills: [],
      topics: [],
      collaborators: [],
      enabled: true,
    });
    setCreateExtras(extractExtrasFromAgent(null));
    setCreateFormCategory('general');
    setTopicIssues({
      invalidFormat: [],
      tooLong: [],
      overflowed: false,
    });
  };

  const applyTopics = (rawTopics: string[]) => {
    const normalized = normalizeTopics(rawTopics);
    setFormData((prev) => ({ ...prev, topics: normalized.topics }));
    setTopicIssues({
      invalidFormat: normalized.invalidFormat,
      tooLong: normalized.tooLong,
      overflowed: normalized.overflowed,
    });
    return normalized;
  };

  const getTopicValidationMessage = () => {
    if (topicIssues.tooLong.length > 0) return t('agents.topicTooLong');
    if (topicIssues.invalidFormat.length > 0) return t('agents.topicInvalidFormat');
    if (topicIssues.overflowed) return t('agents.topicLimitExceeded', { max: TOPIC_MAX_COUNT });
    return null;
  };

  const topicHelpMessage = getTopicValidationMessage();
  const topicsExtraNode = (
    <div className="space-y-1.5">
      <div>{t('agents.topicsExtra')}</div>
      <div className="text-xs text-gray-500 dark:text-gray-400">
        {t('agents.topicNamingRule')}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-gray-500 dark:text-gray-400">{t('agents.topicRecommended')}:</span>
        {TOPIC_RECOMMENDATIONS.map((topic) => {
          const selected = (formData.topics || []).includes(topic);
          return (
            <Button
              key={topic}
              size="small"
              type={selected ? 'primary' : 'default'}
              onClick={() => applyTopics([...(formData.topics || []), topic])}
            >
              {topic}
            </Button>
          );
        })}
      </div>
    </div>
  );

  const validateTopicsBeforeSubmit = (): string[] | null => {
    const normalized = normalizeTopics(formData.topics || []);
    setTopicIssues({
      invalidFormat: normalized.invalidFormat,
      tooLong: normalized.tooLong,
      overflowed: normalized.overflowed,
    });
    setFormData((prev) => ({ ...prev, topics: normalized.topics }));

    if (
      normalized.invalidFormat.length > 0 ||
      normalized.tooLong.length > 0 ||
      normalized.overflowed
    ) {
      addToast({ type: 'error', message: t('agents.topicValidationFailed') });
      return null;
    }
    return normalized.topics;
  };

  const handleCreate = () => {
    if (formData.name.trim()) {
      const topics = validateTopicsBeforeSubmit();
      if (!topics) return;
      createMutation.mutate({
        payload: { ...formData, topics },
        displayCategory: createFormCategory,
        extras: createExtras,
      });
    }
  };

  const handleConfirmAddCategory = () => {
    const label = newCategoryName.trim();
    if (!label) {
      addToast({ type: 'error', message: t('agents.categoryNameRequired') });
      return;
    }
    addCategoryMutation.mutate(label);
  };

  const handleEdit = (agent: Agent) => {
    setSelectedAgent(agent);
    setEditFormCategory(resolveAgentCategory(agent, categoryOverrides));
    setFormData({
      name: agent.name,
      description: agent.description || '',
      model: agent.model,
      temperature: agent.temperature,
      system_prompt: agent.system_prompt || '',
      skills: agent.skills,
      topics: agent.topics,
      collaborators: agent.collaborators,
      enabled: agent.enabled,
    });
    setEditExtras(extractExtrasFromAgent(agent));
    setTopicIssues({
      invalidFormat: [],
      tooLong: [],
      overflowed: false,
    });
    setEditModalOpen(true);
  };

  const handleUpdate = async () => {
    if (!(selectedAgent && formData.name.trim())) return;
    const topics = validateTopicsBeforeSubmit();
    if (!topics) return;
    try {
      await agentProfilePanelRef.current?.flushBootstrapDrafts?.();
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    await updateMutation.mutateAsync({
      agentId: selectedAgent.id,
      data: applyExtrasToUpdate({ ...formData, topics }, editExtras),
      displayCategory: editFormCategory,
    });
  };

  const handleExport = () => {
    const agentsToExport = selectedAgents.size > 0
      ? agents.filter((a) => selectedAgents.has(a.id))
      : agents;
    
    const dataStr = JSON.stringify(agentsToExport, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `agents-${formatAgentDateISO(new Date(), agentTz)}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    addToast({ type: 'success', message: t('agents.exportOk') });
  };

  const handleImport = async (file: File) => {
    try {
      const text = await file.text();
      const importedAgents = JSON.parse(text);

      if (!Array.isArray(importedAgents)) {
        throw new Error(t('agents.importInvalidFormat'));
      }

      let successCount = 0;
      let errorCount = 0;

      for (const agentData of importedAgents) {
        try {
          await api.createAgent(currentBotId!, {
            name: agentData.name,
            description: agentData.description || null,
            model: agentData.model || null,
            temperature: agentData.temperature || null,
            system_prompt: agentData.system_prompt || null,
            skills: agentData.skills || [],
            topics: agentData.topics || [],
            collaborators: agentData.collaborators || [],
            enabled: agentData.enabled !== undefined ? agentData.enabled : true,
          });
          successCount++;
        } catch (err) {
          errorCount++;
          console.error('Failed to import agent:', err);
        }
      }

      queryClient.invalidateQueries({ queryKey: ['agents', currentBotId] });
      addToast({
        type: successCount > 0 ? 'success' : 'error',
        message: t('agents.importComplete', { success: successCount, failed: errorCount }),
      });
      setImportModalOpen(false);
    } catch (err) {
      addToast({
        type: 'error',
        message: t('agents.importFailed', {
          error:
            err instanceof Error ? err.message : t('agents.importUnknownError'),
        }),
      });
    }
  };

  const handleToggleSelect = (agentId: string) => {
    setSelectedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    const ids = batchSelectableAgents.map((a) => a.id);
    const allSelected = ids.length > 0 && ids.every((id) => selectedAgents.has(id));
    if (allSelected) {
      setSelectedAgents(new Set());
    } else {
      setSelectedAgents(new Set(ids));
    }
  };

  if (!currentBotId) {
    return (
      <PageLayout variant="bleed" embedded={embedded}>
        <Empty description={t('agents.selectBotFirst')} className="py-20" />
      </PageLayout>
    );
  }

  return (
    <PageLayout variant="bleed" embedded={embedded} className="min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden">
        <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <h1 className={PAGE_PRIMARY_TITLE_GRADIENT_CLASS}>{t('agents.title')}</h1>
            <p className="mt-1.5 hidden text-sm leading-relaxed text-gray-500 sm:block dark:text-gray-400">
              {t('agents.subtitle')}
            </p>
          </div>
          <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto sm:shrink-0 sm:justify-start">
            <div className="inline-flex items-center rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 dark:border-blue-900/60 dark:bg-blue-900/20 dark:text-blue-300">
              {filteredAgents.length} / {agents.length}
            </div>
            {selectedAgents.size > 0 && (
              <div className="inline-flex items-center rounded-full border border-emerald-100 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-900/20 dark:text-emerald-300">
                {selectedAgents.size}
              </div>
            )}
          </div>
        </div>

        <Card
          className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-gray-200/90 shadow-sm dark:border-gray-700/80 dark:bg-gray-800/35"
          styles={{
            body: { padding: 0, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
          }}
        >
          <div
            className="shrink-0 border-b border-gray-100 bg-gray-50/50 px-4 py-3.5 dark:border-gray-700 dark:bg-gray-800/25 sm:px-5"
            role="search"
            aria-label={t('agents.subtitle')}
          >
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex flex-wrap items-center gap-2">
                {allCategoryTabs.map((cat) => (
                  <button
                    key={cat.key}
                    onClick={() => setSelectedCategory(cat.key)}
                    className={`
                  rounded-full border px-4 py-1.5 text-sm font-medium transition-all duration-200
                  ${
                    selectedCategory === cat.key
                      ? 'border-blue-500 bg-blue-500 text-white shadow-md shadow-blue-500/25'
                      : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-gray-600'
                  }
                `}
                  >
                    {cat.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setNewCategoryName('');
                    setAddCategoryModalOpen(true);
                  }}
                  className="rounded-full border border-dashed border-gray-300 px-4 py-1.5 text-sm font-medium text-gray-500 transition-all hover:border-gray-400 hover:bg-gray-50 hover:text-gray-700 dark:border-gray-600 dark:text-gray-400 dark:hover:border-gray-500 dark:hover:bg-gray-800/60 dark:hover:text-gray-300"
                >
                  {t('agents.addCategory')}
                </button>
              </div>
              <Space align="center" size="small">
                <Button
                  icon={<ReloadOutlined />}
                  onClick={() => refetch()}
                  aria-label={t('common.refresh')}
                  className="border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500"
                >
                  <span className="hidden sm:inline">{t('common.refresh')}</span>
                </Button>
                <Button
                  icon={<UploadOutlined />}
                  onClick={() => setImportModalOpen(true)}
                  aria-label={t('agents.import')}
                  className="border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500"
                >
                  <span className="hidden sm:inline">{t('agents.import')}</span>
                </Button>
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  aria-label={t('agents.newAgent')}
                  onClick={() => {
                    resetForm();
                    setCreateModalOpen(true);
                  }}
                  className="shadow-md shadow-blue-500/25"
                >
                  <span className="hidden sm:inline">{t('agents.newAgent')}</span>
                </Button>
              </Space>
            </div>
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-4 pb-5 pt-4 sm:px-5">
      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spin size="large" />
        </div>
      ) : error ? (
        <Empty description={t('agents.loadError', { error: (error as Error).message })} className="py-12" />
      ) : filteredAgents.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
          <Empty
            description={
              <span className="text-gray-500 dark:text-gray-400">
                {t('agents.emptyHint')}
              </span>
            }
          />
        </div>
      ) : (
        <div className="mx-auto grid w-full max-w-[1920px] grid-cols-1 items-stretch gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {filteredAgents.map((agent) => {
            const isSelected = selectedAgents.has(agent.id);
            const mainGateway = isMainGatewayAgent(agent);

            const descRaw = (agent.description ?? '').trim();
            const modelRaw = (agent.model ?? '').trim();
            let summaryPrimary: ReactNode | null = null;
            if (!mainGateway) {
              if (descRaw) {
                summaryPrimary = (
                  <div className="space-y-1.5">
                    <p className="line-clamp-3 whitespace-pre-wrap break-words text-[12px] leading-snug text-gray-600 dark:text-gray-300">
                      {descRaw}
                    </p>
                    {modelRaw ? (
                      <Tag className="m-0 inline-block max-w-full truncate border-transparent bg-blue-50/90 font-mono text-[11px] leading-tight text-blue-800 dark:bg-blue-950/55 dark:text-blue-200">
                        {modelRaw}
                      </Tag>
                    ) : null}
                  </div>
                );
              } else if (modelRaw) {
                summaryPrimary = (
                  <Tag className="m-0 max-w-full truncate border-gray-200/90 bg-gray-50 font-mono text-[11px] leading-tight dark:border-gray-600 dark:bg-gray-900/55">
                    {modelRaw}
                  </Tag>
                );
              } else {
                summaryPrimary = (
                  <span className="text-[12px] italic text-gray-400 dark:text-gray-500">
                    {t('agents.cardSummaryEmpty')}
                  </span>
                );
              }
            }

            const actionGhost =
              '!h-8 !w-min !border-0 !p-1 text-gray-500 hover:bg-gray-100 hover:!text-blue-600 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:!text-blue-400';

            return (
              <Card
                key={agent.id}
                className="group flex h-full min-h-[156px] flex-col overflow-hidden rounded-xl border border-gray-200/95 bg-white shadow-sm transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:border-gray-300 hover:shadow-md dark:border-gray-700 dark:bg-gray-800"
                styles={{
                  body: {
                    padding: 0,
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    minHeight: 0,
                  },
                }}
                hoverable
              >
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="flex flex-1 flex-col gap-2.5 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 pr-1">
                        <h3 className="line-clamp-2 break-words text-sm font-semibold leading-snug tracking-tight text-gray-900 dark:text-gray-100">
                          {agent.name}
                        </h3>
                        {mainGateway && (
                          <div className="mt-2">
                            <Tag color="blue" bordered={false} className="m-0 px-2 py-0 text-[11px] leading-5">
                              {t('agents.mainGatewayBadge')}
                            </Tag>
                          </div>
                        )}
                      </div>
                      <Checkbox
                        checked={isSelected}
                        disabled={mainGateway}
                        onChange={() => handleToggleSelect(agent.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="relative top-[1px] shrink-0"
                      />
                    </div>

                    <div className="min-h-[2.75rem] flex-1">
                      {mainGateway ? (
                        <div className="flex items-start gap-2 text-[12px] leading-snug text-gray-500 dark:text-gray-400">
                          <Tooltip title={t('agents.mainGatewayHint')} placement="topLeft">
                            <button
                              type="button"
                              aria-label={t('agents.mainGatewayHint')}
                              onClick={(e) => e.stopPropagation()}
                              className="mt-px shrink-0 cursor-default rounded p-px text-gray-400 outline-none hover:text-gray-500 focus-visible:ring-2 focus-visible:ring-blue-400 dark:text-gray-500 dark:hover:text-gray-400"
                            >
                              <InfoCircleOutlined className="text-[15px]" />
                            </button>
                          </Tooltip>
                          <span className="min-w-0">
                            <span className="text-gray-600 dark:text-gray-300">{t('agents.mainGatewayCardLine')}</span>{' '}
                            <Link
                              to="/memory?section=profile"
                              onClick={(e) => e.stopPropagation()}
                              className="font-medium whitespace-nowrap text-blue-600 underline-offset-4 hover:underline dark:text-blue-400"
                            >
                              {t('agents.openBotProfilePage')}
                            </Link>
                          </span>
                        </div>
                      ) : (
                        summaryPrimary
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-3 border-t border-gray-100 bg-gray-50/50 px-4 py-3 dark:border-gray-700/90 dark:bg-gray-900/25">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <span
                        aria-hidden
                        className={`h-2 w-2 shrink-0 rounded-full ${agent.enabled ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                      />
                      <span className="shrink-0 text-[11px] font-medium text-gray-600 dark:text-gray-300">
                        {agent.enabled ? t('common.enabled') : t('agents.hide')}
                      </span>
                      <span
                        className="min-w-0 truncate font-mono text-[10px] text-gray-400 dark:text-gray-500"
                        title={agent.id}
                      >
                        {agent.id}
                      </span>
                    </div>
                    <div className="grid w-[90px] shrink-0 grid-cols-3 items-center justify-items-center gap-0">
                      {!mainGateway ? (
                        <Tooltip title={t('agents.tooltipEdit')}>
                          <Button
                            type="text"
                            size="small"
                            icon={<EditOutlined />}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleEdit(agent);
                            }}
                            className={`${actionGhost} justify-self-center`}
                          />
                        </Tooltip>
                      ) : (
                        <span className="inline-block h-8 w-8 shrink-0" aria-hidden />
                      )}
                      <Tooltip title={t('common.export')}>
                        <Button
                          type="text"
                          size="small"
                          icon={<DownloadOutlined />}
                          onClick={(e) => {
                            e.stopPropagation();
                            const dataStr = JSON.stringify(agent, null, 2);
                            const dataBlob = new Blob([dataStr], {
                              type: 'application/json',
                            });
                            const url = URL.createObjectURL(dataBlob);
                            const link = document.createElement('a');
                            link.href = url;
                            link.download = `agent-${agent.id}.json`;
                            document.body.appendChild(link);
                            link.click();
                            document.body.removeChild(link);
                            URL.revokeObjectURL(url);
                            addToast({
                              type: 'success',
                              message: t('agents.exportOk'),
                            });
                          }}
                          className={`${actionGhost} justify-self-center`}
                        />
                      </Tooltip>
                      {!mainGateway ? (
                        <Popconfirm
                          title={t('agents.hideConfirmTitle')}
                          description={t('agents.hideConfirmDescription')}
                          onConfirm={(e) => {
                            e?.stopPropagation();
                            disableMutation.mutate(agent.id);
                          }}
                          okText={t('agents.hide')}
                          cancelText={t('common.cancel')}
                          okButtonProps={{ danger: true }}
                        >
                          <Tooltip title={t('agents.hide')}>
                            <Button
                              type="text"
                              size="small"
                              icon={<EyeInvisibleOutlined />}
                              onClick={(e) => e.stopPropagation()}
                              className={`${actionGhost} justify-self-center`}
                            />
                          </Tooltip>
                        </Popconfirm>
                      ) : (
                        <span className="inline-block h-8 w-8 shrink-0" aria-hidden />
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
          </div>
        </Card>
      </div>

      {/* Batch Actions */}
      {selectedAgents.size > 0 && (
        <div className="fixed bottom-6 left-1/2 transform -translate-x-1/2 z-10">
          <Card className="rounded-xl border border-gray-200/90 bg-white/95 shadow-xl backdrop-blur dark:border-gray-700 dark:bg-gray-800/90">
            <Space size="middle">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('agents.batchSelected', { count: selectedAgents.size })}
                </span>
              <Divider type="vertical" className="!my-0" />
              <Button size="small" onClick={handleSelectAll}>
                {batchSelectableAgents.length > 0 &&
                batchSelectableAgents.every((a) => selectedAgents.has(a.id))
                  ? t('agents.deselectAll')
                  : t('agents.selectAll')}
              </Button>
              <Button size="small" icon={<DownloadOutlined />} onClick={handleExport}>
                {t('agents.batchExport')}
              </Button>
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={() => {
                  Modal.confirm({
                    title: t('agents.batchDeleteTitle'),
                    content: t('agents.batchDeleteContent', { count: selectedAgents.size }),
                    okText: t('common.delete'),
                    okType: 'danger',
                    cancelText: t('common.cancel'),
                    onOk: () => {
                      selectedAgents.forEach((id) => {
                        if (id === MAIN_GATEWAY_AGENT_ID) return;
                        deleteMutation.mutate(id);
                      });
                      setSelectedAgents(new Set());
                    },
                  });
                }}
              >
                {t('agents.batchDelete')}
              </Button>
            </Space>
          </Card>
        </div>
      )}

      {/* Create Modal */}
      <Modal
        title={t('agents.modalCreateTitle')}
        open={createModalOpen}
        onOk={handleCreate}
        onCancel={() => {
          setCreateModalOpen(false);
          resetForm();
        }}
        okText={t('agents.modalCreateOk')}
        cancelText={t('common.cancel')}
        confirmLoading={createMutation.isPending}
        okButtonProps={{ disabled: !formData.name.trim() }}
        width={640}
        centered
        destroyOnHidden
        styles={AGENT_FORM_MODAL_STYLES}
      >
        <Form layout="vertical" size="middle" requiredMark={false} className="pt-1">
          <Divider titlePlacement="start" plain className="!mt-0 !mb-4">
            <Typography.Text type="secondary" strong className="text-xs uppercase tracking-wide">
              {t('agents.sectionBasic')}
            </Typography.Text>
          </Divider>
          <Form.Item label={t('agents.agentName')} required>
            <Input
              placeholder={t('agents.agentNamePlaceholder')}
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              onPressEnter={handleCreate}
            />
          </Form.Item>
          <Form.Item label={t('agents.description')}>
            <TextArea
              rows={2}
              placeholder={t('agents.descriptionPlaceholder')}
              value={formData.description || ''}
              onChange={(e) => setFormData({ ...formData, description: e.target.value || null })}
            />
          </Form.Item>
          <Form.Item label={t('agents.displayCategory')} extra={t('agents.displayCategoryExtra')}>
            <Select
              value={createFormCategory}
              onChange={(v) => setCreateFormCategory(v)}
              options={selectableCategories.map((c) => ({
                value: c.key,
                label: c.label,
              }))}
              className="w-full"
            />
          </Form.Item>

          <Divider titlePlacement="start" plain className="!mt-6 !mb-4">
            <Typography.Text type="secondary" strong className="text-xs uppercase tracking-wide">
              {t('agents.sectionModel')}
            </Typography.Text>
          </Divider>
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
              value={createExtras.provider_instance_id ?? ''}
              onChange={(v) =>
                setCreateExtras({ ...createExtras, provider_instance_id: v ? v : null })
              }
              options={llmProviderOptions}
              loading={llmProvidersQuery.isLoading}
              placeholder={t('agentProfile.providerInstancePh', 'Pick a provider instance')}
              className="w-full"
            />
          </Form.Item>
          <Row gutter={[16, 0]}>
            <Col xs={24} sm={12}>
              <Form.Item label={t('agents.model')}>
                <Select
                  placeholder={t('agents.modelPlaceholder')}
                  value={formData.model || undefined}
                  onChange={(v) => setFormData({ ...formData, model: v || null })}
                  allowClear
                  showSearch
                  optionFilterProp="value"
                  options={
                    (botStatus?.model ? [botStatus.model] : []).map((m) => ({
                      value: m,
                      label: m,
                    }))
                  }
                  className="w-full"
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label={t('agents.temperature')}>
                <InputNumber
                  min={0}
                  max={2}
                  step={0.1}
                  placeholder={t('agents.temperaturePlaceholder')}
                  value={formData.temperature ?? undefined}
                  onChange={(v) => setFormData({ ...formData, temperature: v ?? null })}
                  className="w-full"
                  changeOnWheel={false}
                />
              </Form.Item>
            </Col>
          </Row>

          <Divider titlePlacement="start" plain className="!mt-2 !mb-4">
            <Typography.Text type="secondary" strong className="text-xs uppercase tracking-wide">
              {t('agents.sectionPromptSkills')}
            </Typography.Text>
          </Divider>
          <Form.Item label={t('agents.systemPrompt')}>
            <TextArea
              rows={4}
              placeholder={t('agents.systemPromptPlaceholder')}
              value={formData.system_prompt || ''}
              onChange={(e) => setFormData({ ...formData, system_prompt: e.target.value || null })}
            />
          </Form.Item>
          <Form.Item label={t('agents.skills')}>
            <Select
              mode="multiple"
              placeholder={t('agents.skillsPlaceholder')}
              value={formData.skills || []}
              onChange={(v) => setFormData({ ...formData, skills: v || [] })}
              options={
                (skillsList || []).map((s) => ({
                  value: s.name,
                  label: s.name,
                }))
              }
              optionRender={(option) => {
                const desc = (option.data as { description?: string })?.description;
                return (
                  <Space>
                    <span>{option.label}</span>
                    {desc && (
                      <Typography.Text type="secondary" className="text-xs">
                        - {desc}
                      </Typography.Text>
                    )}
                  </Space>
                );
              }}
              className="w-full"
            />
          </Form.Item>
          <Form.Item
            label={t('agents.topics')}
            extra={topicsExtraNode}
            validateStatus={topicHelpMessage ? 'error' : undefined}
            help={topicHelpMessage || undefined}
          >
            <Select
              mode="tags"
              placeholder={t('agents.topicsPlaceholder')}
              value={formData.topics || []}
              onChange={(v) => applyTopics(v || [])}
              tokenSeparators={[',']}
              options={TOPIC_RECOMMENDATIONS.map((topic) => ({ value: topic, label: topic }))}
              className="w-full"
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* Edit Modal */}
      <Modal
        title={t('agents.modalEditTitle', { name: selectedAgent?.name ?? '' })}
        open={editModalOpen}
        onOk={handleUpdate}
        onCancel={() => {
          setEditModalOpen(false);
          setSelectedAgent(null);
          resetForm();
        }}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        confirmLoading={updateMutation.isPending}
        okButtonProps={{ disabled: !formData.name.trim() }}
        width={640}
        centered
        destroyOnHidden
        styles={AGENT_FORM_MODAL_STYLES}
      >
        <Form layout="vertical" size="middle" requiredMark={false} className="pt-1">
          <Divider titlePlacement="start" plain className="!mt-0 !mb-4">
            <Typography.Text type="secondary" strong className="text-xs uppercase tracking-wide">
              {t('agents.sectionBasic')}
            </Typography.Text>
          </Divider>
          <Form.Item label={t('agents.agentName')} required>
            <Input
              placeholder={t('agents.agentNamePlaceholderShort')}
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            />
          </Form.Item>
          <Form.Item label={t('agents.description')}>
            <TextArea
              rows={2}
              value={formData.description || ''}
              onChange={(e) => setFormData({ ...formData, description: e.target.value || null })}
            />
          </Form.Item>
          <Form.Item label={t('agents.displayCategory')} extra={t('agents.displayCategoryExtraEdit')}>
            <Select
              value={editFormCategory}
              onChange={(v) => setEditFormCategory(v)}
              options={selectableCategories.map((c) => ({
                value: c.key,
                label: c.label,
              }))}
              className="w-full"
            />
          </Form.Item>

          <Divider titlePlacement="start" plain className="!mt-6 !mb-4">
            <Typography.Text type="secondary" strong className="text-xs uppercase tracking-wide">
              {t('agents.sectionModel')}
            </Typography.Text>
          </Divider>
          <Row gutter={[16, 0]}>
            <Col xs={24} sm={12}>
              <Form.Item label={t('agents.model')}>
                <Select
                  placeholder={t('agents.modelPlaceholder')}
                  value={formData.model || undefined}
                  onChange={(v) => setFormData({ ...formData, model: v || null })}
                  allowClear
                  showSearch
                  optionFilterProp="value"
                  options={
                    (botStatus?.model ? [botStatus.model] : []).map((m) => ({
                      value: m,
                      label: m,
                    }))
                  }
                  className="w-full"
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label={t('agents.temperature')}>
                <InputNumber
                  min={0}
                  max={2}
                  step={0.1}
                  placeholder={t('agents.temperaturePlaceholder')}
                  value={formData.temperature ?? undefined}
                  onChange={(v) => setFormData({ ...formData, temperature: v ?? null })}
                  className="w-full"
                  changeOnWheel={false}
                />
              </Form.Item>
            </Col>
          </Row>

          <Divider titlePlacement="start" plain className="!mt-2 !mb-4">
            <Typography.Text type="secondary" strong className="text-xs uppercase tracking-wide">
              {t('agents.sectionPromptSkills')}
            </Typography.Text>
          </Divider>
          <Form.Item label={t('agents.systemPrompt')}>
            <TextArea
              rows={4}
              value={formData.system_prompt || ''}
              onChange={(e) => setFormData({ ...formData, system_prompt: e.target.value || null })}
            />
          </Form.Item>
          <Form.Item label={t('agents.skills')}>
            <Select
              mode="multiple"
              placeholder={t('agents.skillsPlaceholder')}
              value={formData.skills || []}
              onChange={(v) => setFormData({ ...formData, skills: v || [] })}
              options={
                (skillsList || []).map((s) => ({
                  value: s.name,
                  label: s.name,
                }))
              }
              optionRender={(option) => {
                const desc = (option.data as { description?: string })?.description;
                return (
                  <Space>
                    <span>{option.label}</span>
                    {desc && (
                      <Typography.Text type="secondary" className="text-xs">
                        - {desc}
                      </Typography.Text>
                    )}
                  </Space>
                );
              }}
              className="w-full"
            />
          </Form.Item>
          <Form.Item
            label={t('agents.topics')}
            extra={topicsExtraNode}
            validateStatus={topicHelpMessage ? 'error' : undefined}
            help={topicHelpMessage || undefined}
          >
            <Select
              mode="tags"
              placeholder={t('agents.topicsPlaceholder')}
              value={formData.topics || []}
              onChange={(v) => applyTopics(v || [])}
              tokenSeparators={[',']}
              options={TOPIC_RECOMMENDATIONS.map((topic) => ({ value: topic, label: topic }))}
              className="w-full"
            />
          </Form.Item>

          <Divider titlePlacement="start" plain className="!mt-2 !mb-4">
            <Typography.Text type="secondary" strong className="text-xs uppercase tracking-wide">
              {t('agents.sectionStatus')}
            </Typography.Text>
          </Divider>
          <Form.Item label={t('common.enabled')}>
            <Switch
              checked={formData.enabled}
              onChange={(checked) => setFormData({ ...formData, enabled: checked })}
            />
          </Form.Item>

          <Collapse
            ghost
            bordered={false}
            className="mt-2 bg-transparent"
            items={[
              {
                key: 'profile',
                label: (
                  <Typography.Text type="secondary" strong className="text-xs uppercase tracking-wide">
                    {t('agentProfile.collapseTitle', 'Independent persona / tools / model')}
                  </Typography.Text>
                ),
                children: (
                  <AgentProfilePanel
                    ref={agentProfilePanelRef}
                    agent={selectedAgent}
                    extras={editExtras}
                    onChange={setEditExtras}
                  />
                ),
              },
            ]}
          />
        </Form>
      </Modal>

      <Modal
        title={t('agents.modalAddCategoryTitle')}
        open={addCategoryModalOpen}
        onOk={handleConfirmAddCategory}
        onCancel={() => {
          setAddCategoryModalOpen(false);
          setNewCategoryName('');
        }}
        okText={t('agents.add')}
        cancelText={t('common.cancel')}
        destroyOnHidden
      >
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
          {t('agents.modalAddCategoryHint')}
        </p>
        <Input
          placeholder={t('agents.categoryNamePlaceholder')}
          value={newCategoryName}
          onChange={(e) => setNewCategoryName(e.target.value)}
          onPressEnter={handleConfirmAddCategory}
          maxLength={32}
          showCount
        />
      </Modal>

      {/* Import Modal */}
      <Modal
        title={t('agents.modalImportTitle')}
        open={importModalOpen}
        onCancel={() => setImportModalOpen(false)}
        footer={null}
        width={500}
      >
        <div className="py-4">
          <Upload.Dragger
            accept=".json"
            beforeUpload={(file) => {
              handleImport(file);
              return false;
            }}
            showUploadList={false}
          >
            <p className="ant-upload-drag-icon">
              <UploadOutlined className="text-4xl text-gray-400" />
            </p>
            <p className="ant-upload-text">{t('agents.importUploadText')}</p>
            <p className="ant-upload-hint">{t('agents.importUploadHint')}</p>
          </Upload.Dragger>
        </div>
      </Modal>
    </PageLayout>
  );
}
