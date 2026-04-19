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
import { useTranslation } from 'react-i18next';
import * as api from '../api/client';
import { useAppStore } from '../store';
import { PageLayout } from '../components/PageLayout';
import type { CronJob, CronScheduleKind } from '../api/types';

function formatSchedule(job: CronJob): string {
  const s = job.schedule;
  if (s.kind === 'every' && s.every_ms) {
    const sec = s.every_ms / 1000;
    if (sec < 60) return `每 ${sec} 秒`;
    if (sec < 3600) return `每 ${Math.floor(sec / 60)} 分钟`;
    return `每 ${Math.floor(sec / 3600)} 小时`;
  }
  if (s.kind === 'cron' && s.expr) {
    return s.expr + (s.tz ? ` (${s.tz})` : '');
  }
  if (s.kind === 'at' && s.at_ms) {
    return new Date(s.at_ms).toLocaleString();
  }
  return '-';
}

function formatNextRun(timestamp?: number | null): string {
  if (!timestamp) return '-';
  const diff = timestamp - Date.now();
  if (diff < 0) return '已逾期';
  if (diff < 60000) return '即将执行';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟后`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时后`;
  return new Date(timestamp).toLocaleString();
}

function isOverdue(job: CronJob): boolean {
  if (!job.enabled || !job.state.next_run_at_ms) return false;
  return job.state.next_run_at_ms < Date.now();
}

function CronJobDetails({ job }: { job: CronJob }) {
  const { currentBotId } = useAppStore();
  const { data: historyData } = useQuery({
    queryKey: ['cron-history', currentBotId, job.id],
    queryFn: () => api.getCronHistory(currentBotId, job.id),
    enabled: !!job.id,
  });
  const history = historyData?.[job.id] || [];

  return (
    <div className="space-y-2 mt-2 pl-0 pt-2 border-t border-gray-100 dark:border-gray-700">
      {job.payload.message && (
        <div className="text-sm text-gray-500 break-words">
          指令：{job.payload.message}
        </div>
      )}
      <div className="text-xs text-gray-400">
        下次执行：{formatNextRun(job.state.next_run_at_ms)}
        {job.state.last_run_at_ms && (
          <> · 上次：{new Date(job.state.last_run_at_ms).toLocaleString()}</>
        )}
      </div>
      {history.length > 0 && (
        <div className="mt-2">
          <div className="text-xs font-medium text-gray-500 mb-1">执行历史</div>
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {[...history].reverse().slice(0, 10).map((h, i) => (
              <div
                key={i}
                className="flex items-center justify-between text-xs py-0.5 border-b border-gray-50 dark:border-gray-800 last:border-0"
              >
                <span className="text-gray-500">
                  {new Date(h.run_at_ms).toLocaleString()}
                </span>
                <Space size={4}>
                  <Tag color={h.status === 'ok' ? 'green' : 'red'} className="m-0 text-xs">
                    {h.status === 'ok' ? '成功' : '失败'}
                  </Tag>
                  <span className="text-gray-400">
                    {h.duration_ms < 1000 ? `${h.duration_ms}ms` : `${(h.duration_ms / 1000).toFixed(1)}s`}
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
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [form] = Form.useForm();

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
  });

  const { data: cronStatus } = useQuery({
    queryKey: ['cron-status', currentBotId],
    queryFn: () => api.getCronStatus(currentBotId),
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
        throw new Error('请填写有效的调度配置');
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
    onError: (e) => addToast({ type: 'error', message: String(e) }),
  });

  const removeMutation = useMutation({
    mutationFn: (jobId: string) => api.removeCronJob(jobId, currentBotId),
    onSuccess: () => {
      addToast({ type: 'success', message: t('cron.deleted') });
      queryClient.invalidateQueries({ queryKey: ['cron', currentBotId] });
      queryClient.invalidateQueries({ queryKey: ['cron-status', currentBotId] });
    },
    onError: (e) => addToast({ type: 'error', message: String(e) }),
  });

  const enableMutation = useMutation({
    mutationFn: ({ jobId, enabled }: { jobId: string; enabled: boolean }) =>
      api.enableCronJob(jobId, enabled, currentBotId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cron', currentBotId] });
      queryClient.invalidateQueries({ queryKey: ['cron-status', currentBotId] });
    },
    onError: (e) => addToast({ type: 'error', message: String(e) }),
  });

  const runMutation = useMutation({
    mutationFn: (jobId: string) => api.runCronJob(jobId, true, currentBotId),
    onSuccess: () => {
      addToast({ type: 'success', message: t('cron.triggered') });
      queryClient.invalidateQueries({ queryKey: ['cron', currentBotId] });
      queryClient.invalidateQueries({ queryKey: ['cron-history', currentBotId] });
    },
    onError: (e) => addToast({ type: 'error', message: String(e) }),
  });

  const handleAdd = () => {
    form.validateFields().then((values) => addMutation.mutate(values));
  };

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
        <Alert type="error" message="加载失败" description={String(error)} showIcon />
      </PageLayout>
    );
  }

  const { Text } = Typography;

  const enabledCount = jobs.filter((j) => j.enabled).length;

  return (
    <PageLayout>
      {/* Page header */}
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
              定时任务
            </h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 max-w-xl leading-relaxed">
              管理 Cron 定时任务，Agent 会按计划执行提醒
            </p>
          </div>
        </div>
        <Space className="w-full sm:w-auto justify-end flex-wrap">
          <Button icon={<ReloadOutlined />} onClick={() => refetch()}>
            <span className="hidden sm:inline">刷新</span>
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddModalOpen(true)}>
            添加任务
          </Button>
        </Space>
      </div>

      {/* Status summary */}
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
                Cron 服务
              </Text>
              <div className="font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2 flex-wrap">
                {cronStatus?.enabled ? (
                  <>
                    <Badge status="processing" color="#22c55e" />
                    <span>运行中</span>
                  </>
                ) : (
                  <>
                    <Badge status="default" />
                    <span>未启动</span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-col justify-center gap-0.5 p-4 sm:p-5">
            <Text type="secondary" className="text-xs">
              任务
            </Text>
            <div className="text-lg font-semibold tabular-nums text-gray-900 dark:text-gray-100">
              {jobs.length}
              <Text type="secondary" className="text-sm font-normal ml-1.5">
                个 · {enabledCount} 个启用
              </Text>
            </div>
          </div>
          <div className="flex flex-col justify-center gap-0.5 p-4 sm:p-5">
            <Text type="secondary" className="text-xs">
              调度器下次唤醒
            </Text>
            <div className="text-sm font-medium text-gray-800 dark:text-gray-200">
              {cronStatus?.next_wake_at_ms
                ? formatNextRun(cronStatus.next_wake_at_ms)
                : '—'}
            </div>
          </div>
        </div>
      </Card>

      {/* Task list */}
      <Card
        title={
          <span className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800">
              <SyncOutlined className="text-blue-500 dark:text-blue-400 text-sm" />
            </span>
            任务列表
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
                <span className="text-gray-500 dark:text-gray-400">暂无定时任务，添加后 Agent 将按计划执行</span>
              }
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setAddModalOpen(true)}
              className="mt-4"
            >
              添加任务
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
                      立即执行
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
                      title="确定删除此任务？"
                      onConfirm={() => removeMutation.mutate(job.id)}
                    >
                      <Button type="link" danger size="small" icon={<DeleteOutlined />}>
                        删除
                      </Button>
                    </Popconfirm>,
                  ].filter(Boolean)}
                >
                  <List.Item.Meta
                    avatar={
                      <Tag color={job.enabled ? 'green' : 'default'}>
                        {job.enabled ? '启用' : '禁用'}
                      </Tag>
                    }
                    title={
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{job.name}</span>
                        {isOverdue(job) && (
                          <Tag color="orange">逾期</Tag>
                        )}
                        {job.state.last_status === 'error' && (
                          <Tag color="red">上次失败</Tag>
                        )}
                        <Text type="secondary" className="text-sm font-normal">
                          {formatSchedule(job)}
                        </Text>
                      </div>
                    }
                    description={
                      isExpanded && hasDetails ? (
                        <CronJobDetails job={job} />
                      ) : null
                    }
                  />
                </List.Item>
              );
            }}
          />
          </div>
        )}
      </Card>

      {/* Add Modal */}
      <Modal
        title="添加定时任务"
        open={addModalOpen}
        onOk={handleAdd}
        onCancel={() => {
          setAddModalOpen(false);
          form.resetFields();
        }}
        confirmLoading={addMutation.isPending}
        okText="添加"
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ scheduleKind: 'every', every_seconds: 3600 }}
        >
          <Form.Item name="name" label="任务名称" rules={[{ required: true }]}>
            <Input placeholder="例如：每日提醒" />
          </Form.Item>
          <Form.Item name="scheduleKind" label="调度类型">
            <Select
              options={[
                { value: 'every', label: '固定间隔' },
                { value: 'cron', label: 'Cron 表达式' },
              ]}
            />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(prev, curr) => prev.scheduleKind !== curr.scheduleKind}
          >
            {({ getFieldValue }) =>
              getFieldValue('scheduleKind') === 'every' ? (
                <Form.Item name="every_seconds" label="间隔（秒）" rules={[{ required: true }]}>
                  <InputNumber min={60} placeholder="秒，如 3600 = 每小时" className="w-full" />
                </Form.Item>
              ) : (
                <>
                  <Form.Item name="cron_expr" label="Cron 表达式" rules={[{ required: true }]}>
                    <Input placeholder="如 0 9 * * * (每天 9:00)" />
                  </Form.Item>
                  <Form.Item name="cron_tz" label="时区（可选）">
                    <Input placeholder="如 Asia/Shanghai" />
                  </Form.Item>
                </>
              )
            }
          </Form.Item>
          <Form.Item name="message" label="执行指令（发送给 Agent）">
            <Input.TextArea rows={3} placeholder="任务触发时 Agent 会收到的指令内容" />
          </Form.Item>
        </Form>
      </Modal>
    </PageLayout>
  );
}
