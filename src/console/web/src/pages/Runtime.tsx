import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  PlayCircleOutlined,
  PauseCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { Bot, Cpu } from 'lucide-react';
import { PageLayout } from '../components/PageLayout';
import { useAppStore } from '../store';
import * as api from '../api/client';
import type {
  RuntimeAgentStatus,
  RuntimeSubagentStartBody,
} from '../api/types_runtime';

const { Text } = Typography;

const REFRESH_INTERVAL_MS = 4000;

function formatUptime(seconds?: number | null): string {
  if (seconds == null || Number.isNaN(seconds) || seconds < 0) return '—';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function phaseTagColor(phase?: string | null, running?: boolean): string {
  if (!running) return 'default';
  if (!phase) return 'blue';
  switch (phase) {
    case 'running':
    case 'awaiting_tools':
    case 'tools_completed':
    case 'final_response':
      return 'processing';
    case 'initializing':
      return 'cyan';
    case 'done':
      return 'success';
    case 'error':
      return 'error';
    case 'cancelled':
      return 'warning';
    default:
      return 'blue';
  }
}

export default function Runtime({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const addToast = useAppStore((s) => s.addToast);
  const [startModalOpen, setStartModalOpen] = useState(false);
  const [form] = Form.useForm<RuntimeSubagentStartBody>();

  const agentsQuery = useQuery({
    queryKey: ['runtime-agents'],
    queryFn: api.listRuntimeAgents,
    refetchInterval: REFRESH_INTERVAL_MS,
    retry: false,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['runtime-agents'] });

  const startMainMutation = useMutation({
    mutationFn: api.startMainAgent,
    onSuccess: (res) => {
      addToast({
        type: res.changed ? 'success' : 'info',
        message: res.message,
      });
      invalidate();
    },
    onError: (err: Error) => {
      addToast({
        type: 'error',
        message: t('runtime.actionFailed', { error: err.message }),
      });
    },
  });

  const stopMainMutation = useMutation({
    mutationFn: api.stopMainAgent,
    onSuccess: (res) => {
      addToast({
        type: res.changed ? 'success' : 'info',
        message: res.message,
      });
      invalidate();
    },
    onError: (err: Error) => {
      addToast({
        type: 'error',
        message: t('runtime.actionFailed', { error: err.message }),
      });
    },
  });

  const startSubMutation = useMutation({
    mutationFn: (body: RuntimeSubagentStartBody) =>
      api.startRuntimeSubagent(body),
    onSuccess: (res) => {
      addToast({ type: 'success', message: res.message });
      setStartModalOpen(false);
      form.resetFields();
      invalidate();
    },
    onError: (err: Error) => {
      addToast({
        type: 'error',
        message: t('runtime.startSubFailed', { error: err.message }),
      });
    },
  });

  const stopSubMutation = useMutation({
    mutationFn: (agentId: string) => api.stopRuntimeSubagent(agentId),
    onSuccess: (res) => {
      addToast({
        type: res.changed ? 'success' : 'info',
        message: res.message,
      });
      invalidate();
    },
    onError: (err: Error) => {
      addToast({
        type: 'error',
        message: t('runtime.stopSubFailed', { error: err.message }),
      });
    },
  });

  const rows = agentsQuery.data ?? [];
  const mainRow = useMemo(() => rows.find((r) => r.role === 'main') ?? null, [rows]);
  const subRows = useMemo(() => rows.filter((r) => r.role === 'sub'), [rows]);
  const runningSubCount = subRows.filter((r) => r.running).length;

  const errorMessage =
    agentsQuery.error instanceof Error ? agentsQuery.error.message : null;

  const handleSubmitStartSub = () => {
    form
      .validateFields()
      .then((values) => {
        const payload: RuntimeSubagentStartBody = {
          task: values.task,
          label: values.label || null,
          parent_agent_id: values.parent_agent_id || null,
          team_id: values.team_id || null,
        };
        startSubMutation.mutate(payload);
      })
      .catch(() => undefined);
  };

  const renderRoleTag = (row: RuntimeAgentStatus) => {
    if (row.role === 'main') {
      return (
        <Tag color="geekblue" icon={<Cpu className="inline h-3 w-3" />}>
          {t('runtime.roleMain')}
        </Tag>
      );
    }
    return (
      <Tag color="purple" icon={<Bot className="inline h-3 w-3" />}>
        {t('runtime.roleSub')}
      </Tag>
    );
  };

  const columns = [
    {
      title: t('runtime.colAgentId'),
      dataIndex: 'agent_id',
      key: 'agent_id',
      render: (_: unknown, row: RuntimeAgentStatus) => (
        <Space direction="vertical" size={0} className="min-w-[160px]">
          <Space size={6} align="center">
            {renderRoleTag(row)}
            <Text className="font-mono text-[12px]">{row.agent_id}</Text>
          </Space>
          {row.label && (
            <Text type="secondary" className="text-xs">
              {row.label}
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: t('runtime.colStatus'),
      dataIndex: 'running',
      key: 'running',
      render: (_: unknown, row: RuntimeAgentStatus) => (
        <Space direction="vertical" size={0}>
          <Tag color={phaseTagColor(row.phase, row.running)}>
            {row.running ? t('runtime.running') : t('runtime.stopped')}
            {row.phase ? ` · ${row.phase}` : ''}
          </Tag>
          {row.iteration != null && (
            <Text type="secondary" className="text-xs">
              {t('runtime.iteration', { n: row.iteration })}
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: t('runtime.colUptime'),
      key: 'uptime',
      render: (_: unknown, row: RuntimeAgentStatus) => (
        <Text className="text-xs">{formatUptime(row.uptime_seconds)}</Text>
      ),
    },
    {
      title: t('runtime.colMeta'),
      key: 'meta',
      render: (_: unknown, row: RuntimeAgentStatus) => (
        <Space direction="vertical" size={2} className="min-w-[160px]">
          {row.team_id && (
            <Tag color="purple" className="!m-0">
              team:{row.team_id}
            </Tag>
          )}
          {row.parent_agent_id && (
            <Text type="secondary" className="text-xs">
              {t('runtime.parent')}: {row.parent_agent_id}
            </Text>
          )}
          {row.session_key && (
            <Text type="secondary" className="text-xs">
              session: {row.session_key}
            </Text>
          )}
          {row.task_description && (
            <Tooltip title={row.task_description}>
              <Text type="secondary" className="line-clamp-2 max-w-[280px] text-xs">
                {row.task_description}
              </Text>
            </Tooltip>
          )}
          {row.error && (
            <Text type="danger" className="text-xs">
              {row.error}
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: t('runtime.colActions'),
      key: 'actions',
      width: 160,
      render: (_: unknown, row: RuntimeAgentStatus) => {
        if (row.role === 'main') {
          return row.running ? (
            <Popconfirm
              title={t('runtime.confirmStopMain')}
              okText={t('runtime.stop')}
              cancelText={t('common.cancel')}
              okButtonProps={{ danger: true }}
              onConfirm={() => stopMainMutation.mutate()}
            >
              <Button
                size="small"
                danger
                icon={<PauseCircleOutlined />}
                loading={stopMainMutation.isPending}
              >
                {t('runtime.stop')}
              </Button>
            </Popconfirm>
          ) : (
            <Button
              size="small"
              type="primary"
              icon={<PlayCircleOutlined />}
              loading={startMainMutation.isPending}
              onClick={() => startMainMutation.mutate()}
            >
              {t('runtime.start')}
            </Button>
          );
        }
        if (!row.running) {
          return <Text type="secondary" className="text-xs">{t('runtime.finished')}</Text>;
        }
        return (
          <Popconfirm
            title={t('runtime.confirmStopSub')}
            okText={t('runtime.stop')}
            cancelText={t('common.cancel')}
            okButtonProps={{ danger: true }}
            onConfirm={() => stopSubMutation.mutate(row.agent_id)}
          >
            <Button
              size="small"
              danger
              icon={<StopOutlined />}
              loading={
                stopSubMutation.isPending && stopSubMutation.variables === row.agent_id
              }
            >
              {t('runtime.stop')}
            </Button>
          </Popconfirm>
        );
      },
    },
  ];

  return (
    <PageLayout embedded={embedded}>
      <div className="shrink-0 rounded-xl border border-gray-200/80 bg-white/90 p-4 shadow-sm dark:border-gray-700/70 dark:bg-gray-800/60">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-gray-100">
              {t('runtime.title')}
            </h1>
            <p className="mt-1.5 text-sm text-gray-500 dark:text-gray-400">
              {t('runtime.subtitle')}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 dark:border-blue-900/60 dark:bg-blue-900/20 dark:text-blue-300">
              {t('runtime.summary', {
                main: mainRow?.running
                  ? t('runtime.running')
                  : t('runtime.stopped'),
                sub: runningSubCount,
              })}
            </div>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => agentsQuery.refetch()}
              loading={agentsQuery.isFetching && !agentsQuery.isLoading}
            >
              <span className="hidden sm:inline">{t('common.refresh')}</span>
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setStartModalOpen(true)}
              disabled={!mainRow}
            >
              <span className="hidden sm:inline">{t('runtime.startSub')}</span>
            </Button>
          </div>
        </div>
      </div>

      {errorMessage && (
        <Alert
          type="error"
          showIcon
          message={t('runtime.unavailable')}
          description={errorMessage}
        />
      )}

      <Card
        className="rounded-xl border border-gray-200/80 bg-white shadow-sm dark:border-gray-700/60 dark:bg-gray-800/60"
        styles={{ body: { padding: 0 } }}
      >
        {agentsQuery.isLoading ? (
          <div className="flex justify-center py-12">
            <Spin size="large" />
          </div>
        ) : rows.length === 0 ? (
          <Empty description={t('runtime.empty')} className="py-12" />
        ) : (
          <Table<RuntimeAgentStatus>
            rowKey="agent_id"
            dataSource={rows}
            columns={columns}
            pagination={false}
            size="middle"
          />
        )}
      </Card>

      <Modal
        title={t('runtime.startSubTitle')}
        open={startModalOpen}
        onCancel={() => {
          setStartModalOpen(false);
          form.resetFields();
        }}
        onOk={handleSubmitStartSub}
        confirmLoading={startSubMutation.isPending}
        okText={t('runtime.start')}
        cancelText={t('common.cancel')}
        destroyOnHidden
      >
        <Form layout="vertical" form={form} className="pt-2">
          <Form.Item
            label={t('runtime.fieldTask')}
            name="task"
            rules={[{ required: true, message: t('runtime.fieldTaskRequired') }]}
          >
            <Input.TextArea
              rows={4}
              placeholder={t('runtime.fieldTaskPlaceholder')}
            />
          </Form.Item>
          <Form.Item label={t('runtime.fieldLabel')} name="label">
            <Input placeholder={t('runtime.fieldLabelPlaceholder')} />
          </Form.Item>
          <Form.Item
            label={t('runtime.fieldParent')}
            name="parent_agent_id"
            extra={t('runtime.fieldParentExtra')}
          >
            <Input placeholder={mainRow?.agent_id ?? ''} />
          </Form.Item>
          <Form.Item
            label={t('runtime.fieldTeam')}
            name="team_id"
            extra={t('runtime.fieldTeamExtra')}
          >
            <Input placeholder="team-001" />
          </Form.Item>
        </Form>
      </Modal>
    </PageLayout>
  );
}
