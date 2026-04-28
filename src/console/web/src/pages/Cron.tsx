import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  List,
  Popconfirm,
  Spin,
  Alert,
  Empty,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  ReloadOutlined,
  PlusOutlined,
  PlayCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  HistoryOutlined,
  SyncOutlined,
  RobotOutlined,
  ToolOutlined,
  ApiOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import * as api from '../api/client';
import { useAppStore } from '../store';
import { useBots } from '../hooks/useBots';
import { PageLayout } from '../components/PageLayout';
import { PAGE_PRIMARY_TITLE_CLASS } from '../utils/pageTitleClasses';
import type { CronAddRequest, CronJob } from '../api/types';
import { formatQueryError } from '../utils/errors';
import { useAgentTimeZone } from '../hooks/useAgentTimeZone';
import { formatAgentLocaleString } from '../utils/agentDatetime';
import {
  decodeCronMessage,
  isMetadataExpired,
  isMetadataNotYetActive,
  type CronTaskMetadata,
} from '../utils/cronMetadata';
import { CronTaskFormModal } from './cron/CronTaskFormModal';
import { CronHistoryDrawer } from './cron/CronHistoryDrawer';

const { Text } = Typography;

function formatSchedule(
  job: CronJob,
  t: TFunction,
  timeZone: string,
  locale: string,
): string {
  const s = job.schedule;
  if (s.kind === 'every' && s.every_ms) {
    const sec = s.every_ms / 1000;
    if (sec < 60) return t('cron.everySeconds', { count: sec });
    if (sec < 3600) return t('cron.everyMinutes', { count: Math.floor(sec / 60) });
    return t('cron.everyHours', { count: Math.floor(sec / 3600) });
  }
  if (s.kind === 'cron' && s.expr) {
    return s.expr + (s.tz ? ` (${s.tz})` : '');
  }
  if (s.kind === 'at' && s.at_ms) {
    return formatAgentLocaleString(s.at_ms, timeZone, locale);
  }
  return t('cron.scheduleDash');
}

function formatNextRun(
  timestamp: number | null | undefined,
  t: TFunction,
  timeZone: string,
  locale: string,
): string {
  if (!timestamp) return t('cron.scheduleDash');
  const diff = timestamp - Date.now();
  if (diff < 0) return t('cron.nextOverdue');
  if (diff < 60000) return t('cron.nextSoon');
  if (diff < 3600000) return t('cron.nextInMinutes', { count: Math.floor(diff / 60000) });
  if (diff < 86400000) return t('cron.nextInHours', { count: Math.floor(diff / 3600000) });
  return formatAgentLocaleString(timestamp, timeZone, locale);
}

function isOverdue(job: CronJob): boolean {
  if (!job.enabled || !job.state.next_run_at_ms) return false;
  return job.state.next_run_at_ms < Date.now();
}

function MetadataChips({
  meta,
  agentName,
  t,
}: {
  meta: CronTaskMetadata;
  agentName?: string;
  t: TFunction;
}) {
  const skills = meta.skills ?? [];
  const tools = meta.tools ?? [];
  const mcps = meta.mcpServers ?? [];
  const showAny = agentName || skills.length || tools.length || mcps.length;
  if (!showAny) return null;
  return (
    <Space size={[4, 4]} wrap className="mt-1">
      {agentName && (
        <Tag icon={<RobotOutlined />} color="geekblue">
          {agentName}
        </Tag>
      )}
      {skills.length > 0 && (
        <Tooltip title={skills.join(', ')}>
          <Tag icon={<ThunderboltOutlined />} color="purple">
            {t('cron.chipSkills', { count: skills.length })}
          </Tag>
        </Tooltip>
      )}
      {tools.length > 0 && (
        <Tooltip title={tools.join(', ')}>
          <Tag icon={<ToolOutlined />} color="cyan">
            {t('cron.chipTools', { count: tools.length })}
          </Tag>
        </Tooltip>
      )}
      {mcps.length > 0 && (
        <Tooltip title={mcps.join(', ')}>
          <Tag icon={<ApiOutlined />} color="gold">
            {t('cron.chipMcp', { count: mcps.length })}
          </Tag>
        </Tooltip>
      )}
    </Space>
  );
}

function WindowChips({
  meta,
  t,
  agentTz,
  locale,
}: {
  meta: CronTaskMetadata;
  t: TFunction;
  agentTz: string;
  locale: string;
}) {
  if (!meta.startAtMs && !meta.endAtMs) return null;
  return (
    <Space size={[4, 4]} wrap className="mt-1">
      {meta.startAtMs && (
        <Tag color={isMetadataNotYetActive(meta) ? 'orange' : 'default'}>
          {t('cron.windowFrom', {
            time: formatAgentLocaleString(meta.startAtMs, agentTz, locale),
          })}
        </Tag>
      )}
      {meta.endAtMs && (
        <Tag color={isMetadataExpired(meta) ? 'red' : 'default'}>
          {t('cron.windowTo', {
            time: formatAgentLocaleString(meta.endAtMs, agentTz, locale),
          })}
        </Tag>
      )}
    </Space>
  );
}

export default function Cron({ embedded = false }: { embedded?: boolean } = {}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { addToast, currentBotId } = useAppStore();
  const agentTz = useAgentTimeZone();
  const locale = i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US';
  const { data: bots = [], isLoading: botsLoading, isFetched: botsFetched } = useBots();
  const [formOpen, setFormOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<CronJob | null>(null);
  const [historyJob, setHistoryJob] = useState<CronJob | null>(null);

  const waitingBot = botsFetched && bots.length > 0 && !currentBotId;

  const { data: jobs = [], isLoading, error, refetch } = useQuery({
    queryKey: ['cron', currentBotId],
    queryFn: () => api.listCronJobs(currentBotId, true),
    enabled: Boolean(currentBotId),
  });

  const { data: cronStatus } = useQuery({
    queryKey: ['cron-status', currentBotId],
    queryFn: () => api.getCronStatus(currentBotId),
    enabled: Boolean(currentBotId),
  });

  const { data: agents = [] } = useQuery({
    queryKey: ['cron-page-agents', currentBotId],
    queryFn: () => (currentBotId ? api.listAgents(currentBotId) : Promise.resolve([])),
    enabled: Boolean(currentBotId),
  });

  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents) map.set(a.id, a.name);
    return map;
  }, [agents]);

  const decodedJobs = useMemo(
    () =>
      jobs.map((j) => {
        const { meta, prompt } = decodeCronMessage(j.payload?.message ?? '');
        return { job: j, meta, prompt };
      }),
    [jobs],
  );

  const addMutation = useMutation({
    mutationFn: (payload: CronAddRequest) => api.addCronJob(payload, currentBotId),
    onSuccess: () => {
      addToast({ type: 'success', message: t('cron.added') });
      setFormOpen(false);
      setEditingJob(null);
      queryClient.invalidateQueries({ queryKey: ['cron', currentBotId] });
      queryClient.invalidateQueries({ queryKey: ['cron-status', currentBotId] });
    },
    onError: (e) => addToast({ type: 'error', message: formatQueryError(e) }),
  });

  const removeMutation = useMutation({
    mutationFn: (jobId: string) => api.removeCronJob(jobId, currentBotId),
    onSuccess: () => {
      addToast({ type: 'success', message: t('cron.deleted') });
      queryClient.invalidateQueries({ queryKey: ['cron', currentBotId] });
      queryClient.invalidateQueries({ queryKey: ['cron-status', currentBotId] });
    },
    onError: (e) => addToast({ type: 'error', message: formatQueryError(e) }),
  });

  const enableMutation = useMutation({
    mutationFn: ({ jobId, enabled }: { jobId: string; enabled: boolean }) =>
      api.enableCronJob(jobId, enabled, currentBotId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cron', currentBotId] });
      queryClient.invalidateQueries({ queryKey: ['cron-status', currentBotId] });
    },
    onError: (e) => addToast({ type: 'error', message: formatQueryError(e) }),
  });

  const runMutation = useMutation({
    mutationFn: (jobId: string) => api.runCronJob(jobId, true, currentBotId),
    onSuccess: () => {
      addToast({ type: 'success', message: t('cron.triggered') });
      queryClient.invalidateQueries({ queryKey: ['cron', currentBotId] });
      queryClient.invalidateQueries({ queryKey: ['cron-history', currentBotId] });
    },
    onError: (e) => addToast({ type: 'error', message: formatQueryError(e) }),
  });

  const handleSubmit = (payload: CronAddRequest) => {
    addMutation.mutate(payload);
  };

  if (botsLoading || waitingBot) {
    return (
      <PageLayout variant="center" embedded={embedded}>
        <Spin size="large" />
      </PageLayout>
    );
  }

  if (botsFetched && bots.length === 0) {
    return (
      <PageLayout variant="bleed" embedded={embedded}>
        <Empty description={t('dashboard.botRequired')} />
      </PageLayout>
    );
  }

  if (isLoading) {
    return (
      <PageLayout variant="center" embedded={embedded}>
        <Spin size="large" />
      </PageLayout>
    );
  }

  if (error) {
    return (
      <PageLayout variant="bleed" embedded={embedded}>
        <Alert
          type="error"
          message={t('cron.loadFailed')}
          description={formatQueryError(error)}
          showIcon
        />
      </PageLayout>
    );
  }

  const enabledCount = jobs.filter((j) => j.enabled).length;

  return (
    <PageLayout embedded={embedded} className={embedded ? 'min-h-0 flex-1 gap-6 overflow-hidden' : ''}>
      <div className="flex shrink-0 flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className={PAGE_PRIMARY_TITLE_CLASS}>
            {t('cron.pageTitle')}
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 max-w-xl leading-relaxed">
            {t('cron.pageSubtitle')}
          </p>
        </div>
        <Space className="w-full sm:w-auto justify-end flex-wrap">
          <Button icon={<ReloadOutlined />} onClick={() => refetch()}>
            <span className="hidden sm:inline">{t('common.refresh')}</span>
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditingJob(null);
              setFormOpen(true);
            }}
          >
            {t('cron.addTask')}
          </Button>
        </Space>
      </div>

      <Card
        size="small"
        className="shrink-0 overflow-hidden rounded-md border border-gray-200/90 bg-white/90 shadow-sm dark:border-gray-700/80 dark:bg-gray-900/50"
        styles={{ body: { padding: 0 } }}
      >
        <div className="grid divide-y divide-gray-100 dark:divide-gray-800 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <div className="flex items-center gap-3 p-4 sm:p-5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-blue-100 dark:bg-blue-950/50">
              <SyncOutlined className="text-lg text-blue-600 dark:text-blue-400" />
            </div>
            <div className="min-w-0">
              <Text type="secondary" className="text-xs block mb-0.5">
                {t('cron.serviceLabel')}
              </Text>
              <div className="font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2 flex-wrap">
                {cronStatus?.enabled ? (
                  <>
                    <Badge status="processing" color="#22c55e" />
                    <span>{t('cron.serviceRunning')}</span>
                  </>
                ) : (
                  <>
                    <Badge status="default" />
                    <span>{t('cron.serviceStopped')}</span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-col justify-center gap-0.5 p-4 sm:p-5">
            <Text type="secondary" className="text-xs">
              {t('cron.tasksLabel')}
            </Text>
            <div className="text-lg font-semibold tabular-nums text-gray-900 dark:text-gray-100">
              {jobs.length}
              <Text type="secondary" className="text-sm font-normal ml-1.5">
                {t('cron.taskEnabledHint', { enabled: enabledCount })}
              </Text>
            </div>
          </div>
          <div className="flex flex-col justify-center gap-0.5 p-4 sm:p-5">
            <Text type="secondary" className="text-xs">
              {t('cron.nextWakeLabel')}
            </Text>
            <div className="text-sm font-medium text-gray-800 dark:text-gray-200">
              {cronStatus?.next_wake_at_ms
                ? formatNextRun(cronStatus.next_wake_at_ms, t, agentTz, locale)
                : t('cron.scheduleDash')}
            </div>
          </div>
        </div>
      </Card>

      <Card
        title={
          <span className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-gray-100 dark:bg-gray-800">
              <SyncOutlined className="text-blue-500 dark:text-blue-400 text-sm" />
            </span>
            {t('cron.taskListTitle')}
          </span>
        }
        size="small"
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-gray-200/90 bg-white/90 shadow-sm dark:border-gray-700/80 dark:bg-gray-900/50 [&_.ant-card-head]:border-b-gray-200/80 dark:[&_.ant-card-head]:border-b-gray-700/80"
        styles={{
          body: {
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            minHeight: 0,
            padding: 12,
          },
        }}
      >
        {jobs.length === 0 ? (
          <div className="flex flex-col items-center py-10">
            <Empty
              description={
                <span className="text-gray-500 dark:text-gray-400">{t('cron.emptyDesc')}</span>
              }
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setEditingJob(null);
                setFormOpen(true);
              }}
              className="mt-4"
            >
              {t('cron.addTask')}
            </Button>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
            <List
              split={false}
              dataSource={decodedJobs}
              renderItem={({ job, meta, prompt }) => {
                const agentName = meta.agentId ? agentNameById.get(meta.agentId) : undefined;
                const expired = isMetadataExpired(meta);
                const notYet = isMetadataNotYetActive(meta);
                return (
                  <List.Item
                    className={`mb-2 flex flex-col items-stretch gap-2 rounded border border-gray-100 bg-gray-50/80 px-3 py-2 transition-colors last:mb-0 dark:border-gray-800 dark:bg-gray-800/25 ${
                      !job.enabled
                        ? 'opacity-70'
                        : 'hover:border-gray-200 dark:hover:border-gray-700'
                    }`}
                  >
                    <div className="flex w-full items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0 flex-1">
                        <Space size={6} wrap>
                          <Tag color={job.enabled ? 'green' : 'default'}>
                            {job.enabled ? t('cron.tagEnabled') : t('cron.tagDisabled')}
                          </Tag>
                          <Text strong>{job.name}</Text>
                          {isOverdue(job) && <Tag color="orange">{t('cron.tagOverdue')}</Tag>}
                          {expired && <Tag color="red">{t('cron.tagExpired')}</Tag>}
                          {notYet && <Tag color="blue">{t('cron.tagNotYet')}</Tag>}
                          {job.state.last_status === 'error' && (
                            <Tag color="red">{t('cron.tagLastFailed')}</Tag>
                          )}
                          <Text type="secondary" className="text-xs">
                            {formatSchedule(job, t, agentTz, locale)}
                          </Text>
                          <Text type="secondary" className="text-xs">
                            · {t('cron.detailNextRun')}{' '}
                            {formatNextRun(job.state.next_run_at_ms, t, agentTz, locale)}
                          </Text>
                        </Space>
                        <MetadataChips meta={meta} agentName={agentName} t={t} />
                        <WindowChips meta={meta} t={t} agentTz={agentTz} locale={locale} />
                        {prompt && (
                          <div className="mt-1 max-w-2xl break-words text-xs text-gray-500">
                            <span className="font-medium">{t('cron.detailInstruction')} </span>
                            {prompt.length > 160 ? `${prompt.slice(0, 160)}…` : prompt}
                          </div>
                        )}
                      </div>
                      <Space size={4} className="shrink-0">
                        <Tooltip title={t('cron.historyView')}>
                          <Button
                            type="text"
                            size="small"
                            icon={<HistoryOutlined />}
                            onClick={() => setHistoryJob(job)}
                          />
                        </Tooltip>
                        <Tooltip title={t('common.edit')}>
                          <Button
                            type="text"
                            size="small"
                            icon={<EditOutlined />}
                            onClick={() => {
                              setEditingJob(job);
                              setFormOpen(true);
                            }}
                          />
                        </Tooltip>
                        <Tooltip title={t('cron.runNow')}>
                          <Button
                            type="text"
                            size="small"
                            icon={<PlayCircleOutlined />}
                            loading={runMutation.isPending}
                            onClick={() => runMutation.mutate(job.id)}
                          />
                        </Tooltip>
                        <Switch
                          size="small"
                          checked={job.enabled}
                          loading={enableMutation.isPending}
                          onChange={(checked) =>
                            enableMutation.mutate({ jobId: job.id, enabled: checked })
                          }
                        />
                        <Popconfirm
                          title={t('cron.deleteConfirmTitle')}
                          onConfirm={() => removeMutation.mutate(job.id)}
                        >
                          <Button type="text" danger size="small" icon={<DeleteOutlined />} />
                        </Popconfirm>
                      </Space>
                    </div>
                  </List.Item>
                );
              }}
            />
          </div>
        )}
      </Card>

      <CronTaskFormModal
        open={formOpen}
        botId={currentBotId}
        job={editingJob}
        loading={addMutation.isPending}
        onCancel={() => {
          setFormOpen(false);
          setEditingJob(null);
        }}
        onSubmit={handleSubmit}
      />

      <CronHistoryDrawer
        open={!!historyJob}
        job={historyJob}
        botId={currentBotId}
        agentTz={agentTz}
        locale={locale}
        agentNameById={agentNameById}
        onClose={() => setHistoryJob(null)}
      />
    </PageLayout>
  );
}
