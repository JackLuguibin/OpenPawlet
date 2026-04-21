import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  List,
  Modal,
  Form,
  Input,
  Select,
  InputNumber,
  Switch,
  Popconfirm,
  Spin,
  Alert,
  Empty,
  Space,
  Tag,
  Typography,
} from 'antd';
import {
  ReloadOutlined,
  PlusOutlined,
  PlayCircleOutlined,
  DeleteOutlined,
  ClockCircleOutlined,
  SyncOutlined,
  DownOutlined,
  UpOutlined,
} from '@ant-design/icons';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import * as api from '../api/client';
import { useAppStore } from '../store';
import { useBots } from '../hooks/useBots';
import { PageLayout } from '../components/PageLayout';
import type { CronJob, CronScheduleKind } from '../api/types';
import { formatQueryError } from '../utils/errors';

function formatSchedule(job: CronJob, t: TFunction): string {
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
    return new Date(s.at_ms).toLocaleString();
  }
  return t('cron.scheduleDash');
}

function formatNextRun(timestamp: number | null | undefined, t: TFunction): string {
  if (!timestamp) return t('cron.scheduleDash');
  const diff = timestamp - Date.now();
  if (diff < 0) return t('cron.nextOverdue');
  if (diff < 60000) return t('cron.nextSoon');
  if (diff < 3600000) return t('cron.nextInMinutes', { count: Math.floor(diff / 60000) });
  if (diff < 86400000) return t('cron.nextInHours', { count: Math.floor(diff / 3600000) });
  return new Date(timestamp).toLocaleString();
}

function isOverdue(job: CronJob): boolean {
  if (!job.enabled || !job.state.next_run_at_ms) return false;
  return job.state.next_run_at_ms < Date.now();
}

function CronJobDetails({ job }: { job: CronJob }) {
  const { t } = useTranslation();
  const { currentBotId } = useAppStore();
  const { data: historyData } = useQuery({
    queryKey: ['cron-history', currentBotId, job.id],
    queryFn: () => api.getCronHistory(currentBotId, job.id),
    enabled: Boolean(currentBotId) && !!job.id,
  });
  const history = historyData?.[job.id] || [];

  return (
    <div className="space-y-2 mt-2 pl-0 pt-2 border-t border-gray-100 dark:border-gray-700">
      {job.payload.message && (
        <div className="text-sm text-gray-500 break-words">
          {t('cron.detailInstruction')} {job.payload.message}
        </div>
      )}
      <div className="text-xs text-gray-400">
        {t('cron.detailNextRun')} {formatNextRun(job.state.next_run_at_ms, t)}
        {job.state.last_run_at_ms && (
          <>
            {' '}
            · {t('cron.detailLastRun')} {new Date(job.state.last_run_at_ms).toLocaleString()}
          </>
        )}
      </div>
      {history.length > 0 && (
        <div className="mt-2">
          <div className="text-xs font-medium text-gray-500 mb-1">{t('cron.historyTitle')}</div>
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {[...history].reverse().slice(0, 10).map((h, i) => (
              <div
                key={`${h.run_at_ms}-${i}`}
                className="flex items-center justify-between text-xs py-0.5 border-b border-gray-50 dark:border-gray-800 last:border-0"
              >
                <span className="text-gray-500">{new Date(h.run_at_ms).toLocaleString()}</span>
                <Space size={4}>
                  <Tag color={h.status === 'ok' ? 'green' : 'red'} className="m-0 text-xs">
                    {h.status === 'ok' ? t('cron.runOk') : t('cron.runFail')}
                  </Tag>
                  <span className="text-gray-400">
                    {h.duration_ms < 1000
                      ? `${h.duration_ms}ms`
                      : `${(h.duration_ms / 1000).toFixed(1)}s`}
                  </span>
                </Space>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Cron() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { addToast, currentBotId } = useAppStore();
  const { data: bots = [], isLoading: botsLoading, isFetched: botsFetched } = useBots();
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [form] = Form.useForm();

  const waitingBot = botsFetched && bots.length > 0 && !currentBotId;

  const toggleExpand = (jobId: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  };

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

  const addMutation = useMutation({
    mutationFn: (values: {
      name: string;
      scheduleKind: CronScheduleKind;
      every_seconds?: number;
      cron_expr?: string;
      cron_tz?: string;
      message: string;
    }) => {
      let schedule: { kind: CronScheduleKind; every_ms?: number; expr?: string; tz?: string };
      if (values.scheduleKind === 'every' && values.every_seconds) {
        schedule = { kind: 'every', every_ms: values.every_seconds * 1000 };
      } else if (values.scheduleKind === 'cron' && values.cron_expr) {
        schedule = {
          kind: 'cron',
          expr: values.cron_expr,
          tz: values.cron_tz || undefined,
        };
      } else {
        throw new Error(t('cron.errInvalidSchedule'));
      }
      return api.addCronJob(
        {
          name: values.name,
          schedule,
          message: values.message || '',
        },
        currentBotId
      );
    },
    onSuccess: () => {
      addToast({ type: 'success', message: t('cron.added') });
      setAddModalOpen(false);
      form.resetFields();
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

  const handleAdd = () => {
    form.validateFields().then((values) => addMutation.mutate(values));
  };

  if (botsLoading || waitingBot) {
    return (
      <PageLayout variant="center">
        <Spin size="large" />
      </PageLayout>
    );
  }

  if (botsFetched && bots.length === 0) {
    return (
      <PageLayout variant="bleed">
        <Empty description={t('dashboard.botRequired')} />
      </PageLayout>
    );
  }

  if (isLoading) {
    return (
      <PageLayout variant="center">
        <Spin size="large" />
      </PageLayout>
    );
  }

  if (error) {
    return (
      <PageLayout variant="bleed">
        <Alert
          type="error"
          title={t('cron.loadFailed')}
          description={formatQueryError(error)}
          showIcon
        />
      </PageLayout>
    );
  }

  const { Text } = Typography;

  const enabledCount = jobs.filter((j) => j.enabled).length;

  return (
    <PageLayout>
      <div className="flex shrink-0 flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-4 min-w-0">
          <div
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500/15 to-indigo-600/10 ring-1 ring-violet-500/20 dark:from-violet-400/20 dark:to-indigo-500/15 dark:ring-violet-400/25"
            aria-hidden
          >
            <ClockCircleOutlined className="text-xl text-violet-600 dark:text-violet-300" />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
              {t('cron.pageTitle')}
            </h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 max-w-xl leading-relaxed">
              {t('cron.pageSubtitle')}
            </p>
          </div>
        </div>
        <Space className="w-full sm:w-auto justify-end flex-wrap">
          <Button icon={<ReloadOutlined />} onClick={() => refetch()}>
            <span className="hidden sm:inline">{t('common.refresh')}</span>
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddModalOpen(true)}>
            {t('cron.addTask')}
          </Button>
        </Space>
      </div>

      <Card
        size="small"
        className="shrink-0 overflow-hidden rounded-2xl border border-gray-200/90 bg-white/90 shadow-sm dark:border-gray-700/80 dark:bg-gray-900/50"
        styles={{ body: { padding: 0 } }}
      >
        <div className="grid divide-y divide-gray-100 dark:divide-gray-800 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <div className="flex items-center gap-3 p-4 sm:p-5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-100 dark:bg-blue-950/50">
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
                ? formatNextRun(cronStatus.next_wake_at_ms, t)
                : t('cron.scheduleDash')}
            </div>
          </div>
        </div>
      </Card>

      <Card
        title={
          <span className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800">
              <SyncOutlined className="text-blue-500 dark:text-blue-400 text-sm" />
            </span>
            {t('cron.taskListTitle')}
          </span>
        }
        size="small"
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-gray-200/90 bg-white/90 shadow-sm dark:border-gray-700/80 dark:bg-gray-900/50 [&_.ant-card-head]:border-b-gray-200/80 dark:[&_.ant-card-head]:border-b-gray-700/80"
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
              onClick={() => setAddModalOpen(true)}
              className="mt-4"
            >
              {t('cron.addTask')}
            </Button>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
            <List
              split={false}
              dataSource={jobs}
              renderItem={(job) => {
                const isExpanded = expandedKeys.has(job.id);
                const hasDetails =
                  job.payload.message ||
                  job.state.next_run_at_ms ||
                  job.state.last_run_at_ms;
                return (
                  <List.Item
                    className={`mb-2 rounded-xl border border-gray-100 bg-gray-50/80 px-3 py-2 transition-colors last:mb-0 dark:border-gray-800 dark:bg-gray-800/25 ${!job.enabled ? 'opacity-70' : 'hover:border-gray-200 dark:hover:border-gray-700'}`}
                    actions={[
                      hasDetails && (
                        <Button
                          key="expand"
                          type="text"
                          size="small"
                          icon={isExpanded ? <UpOutlined /> : <DownOutlined />}
                          onClick={() => toggleExpand(job.id)}
                          className="!text-gray-500"
                        />
                      ),
                      <Button
                        key="run"
                        type="link"
                        size="small"
                        icon={<PlayCircleOutlined />}
                        loading={runMutation.isPending}
                        onClick={() => runMutation.mutate(job.id)}
                      >
                        {t('cron.runNow')}
                      </Button>,
                      <Switch
                        key="enable"
                        size="small"
                        checked={job.enabled}
                        loading={enableMutation.isPending}
                        onChange={(checked) =>
                          enableMutation.mutate({ jobId: job.id, enabled: checked })
                        }
                      />,
                      <Popconfirm
                        key="delete"
                        title={t('cron.deleteConfirmTitle')}
                        onConfirm={() => removeMutation.mutate(job.id)}
                      >
                        <Button type="link" danger size="small" icon={<DeleteOutlined />}>
                          {t('common.delete')}
                        </Button>
                      </Popconfirm>,
                    ].filter(Boolean)}
                  >
                    <List.Item.Meta
                      avatar={
                        <Tag color={job.enabled ? 'green' : 'default'}>
                          {job.enabled ? t('cron.tagEnabled') : t('cron.tagDisabled')}
                        </Tag>
                      }
                      title={
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium">{job.name}</span>
                          {isOverdue(job) && <Tag color="orange">{t('cron.tagOverdue')}</Tag>}
                          {job.state.last_status === 'error' && (
                            <Tag color="red">{t('cron.tagLastFailed')}</Tag>
                          )}
                          <Text type="secondary" className="text-sm font-normal">
                            {formatSchedule(job, t)}
                          </Text>
                        </div>
                      }
                      description={
                        isExpanded && hasDetails ? <CronJobDetails job={job} /> : null
                      }
                    />
                  </List.Item>
                );
              }}
            />
          </div>
        )}
      </Card>

      <Modal
        title={t('cron.modalAddTitle')}
        open={addModalOpen}
        onOk={handleAdd}
        onCancel={() => {
          setAddModalOpen(false);
          form.resetFields();
        }}
        confirmLoading={addMutation.isPending}
        okText={t('cron.modalAddOk')}
        cancelText={t('common.cancel')}
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ scheduleKind: 'every', every_seconds: 3600 }}
        >
          <Form.Item name="name" label={t('cron.fieldName')} rules={[{ required: true }]}>
            <Input placeholder={t('cron.fieldNamePh')} />
          </Form.Item>
          <Form.Item name="scheduleKind" label={t('cron.fieldScheduleKind')}>
            <Select
              options={[
                { value: 'every', label: t('cron.scheduleEvery') },
                { value: 'cron', label: t('cron.scheduleCron') },
              ]}
            />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(prev, curr) => prev.scheduleKind !== curr.scheduleKind}
          >
            {({ getFieldValue }) =>
              getFieldValue('scheduleKind') === 'every' ? (
                <Form.Item
                  name="every_seconds"
                  label={t('cron.fieldEverySeconds')}
                  rules={[{ required: true }]}
                >
                  <InputNumber
                    min={60}
                    placeholder={t('cron.fieldEverySecondsPh')}
                    className="w-full"
                  />
                </Form.Item>
              ) : (
                <>
                  <Form.Item
                    name="cron_expr"
                    label={t('cron.fieldCronExpr')}
                    rules={[{ required: true }]}
                  >
                    <Input placeholder={t('cron.fieldCronExprPh')} />
                  </Form.Item>
                  <Form.Item name="cron_tz" label={t('cron.fieldCronTz')}>
                    <Input placeholder={t('cron.fieldCronTzPh')} />
                  </Form.Item>
                </>
              )
            }
          </Form.Item>
          <Form.Item name="message" label={t('cron.fieldMessage')}>
            <Input.TextArea rows={3} placeholder={t('cron.fieldMessagePh')} />
          </Form.Item>
        </Form>
      </Modal>
    </PageLayout>
  );
}
