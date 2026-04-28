import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Card,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  EyeOutlined,
  PlayCircleOutlined,
  PauseCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { RobotOutlined, ApiOutlined } from '@ant-design/icons';
import { PageLayout } from '../components/PageLayout';
import { PAGE_PRIMARY_TITLE_CLASS } from '../utils/pageTitleClasses';
import { useAppStore } from '../store';
import * as api from '../api/client';
import type {
  RuntimeAgentStatus,
  RuntimeSubagentStartBody,
} from '../api/types_runtime';

const { Text } = Typography;

// Heavy fallback interval used only when the `/ws/state` push channel is
// unreachable; runtime status updates land via `runtime_agents_update`
// frames first, and the detail-drawer transcript still refreshes
// periodically because per-message append events are not yet wired up.
const REFRESH_INTERVAL_MS = 4000;
const RUNTIME_FALLBACK_INTERVAL_MS = 30_000;

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
  // When user clicks "启动" on a profile row, we pre-fill the start
  // modal with that profile so they only have to supply a task.
  const [profileSeed, setProfileSeed] = useState<RuntimeAgentStatus | null>(null);
  // Drawer-driven transcript viewer for one runtime row. We hold the entire
  // ``RuntimeAgentStatus`` because the transcript fetch keys off
  // ``session_key`` while the JSON view shows the full status payload.
  const [detailRow, setDetailRow] = useState<RuntimeAgentStatus | null>(null);

  const agentsQuery = useQuery({
    queryKey: ['runtime-agents'],
    queryFn: api.listRuntimeAgents,
    // Live updates come from `/ws/state` (`runtime_agents_update`); the
    // long fallback only covers the case where the socket is blocked.
    refetchInterval: RUNTIME_FALLBACK_INTERVAL_MS,
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
      setProfileSeed(null);
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

  // Sub-agent transcripts persist under ``subagent:<parent>:<task_id>`` so the
  // detail drawer can fetch them via the standard ``/sessions/{key}/transcript``
  // endpoint.  We poll while the row is still running so progress streams in.
  const detailSessionKey =
    detailRow && detailRow.session_key && detailRow.session_key.startsWith('subagent:')
      ? detailRow.session_key
      : null;
  const transcriptQuery = useQuery({
    queryKey: ['runtime-subagent-transcript', detailSessionKey],
    queryFn: () => api.getSessionTranscript(detailSessionKey as string),
    enabled: !!detailSessionKey,
    refetchInterval: detailRow?.running ? REFRESH_INTERVAL_MS : false,
    retry: false,
  });

  const rows = agentsQuery.data ?? [];
  const mainRow = useMemo(() => rows.find((r) => r.role === 'main') ?? null, [rows]);
  const subRows = useMemo(() => rows.filter((r) => r.role === 'sub'), [rows]);
  const agentRows = useMemo(() => rows.filter((r) => r.role === 'agent'), [rows]);
  // Subagent counter shown in the summary chip blends ad-hoc sub-agent
  // tasks with the standalone "enabled = running" agent loops so the
  // chip reflects everything that's actively burning resources.
  const runningSubCount =
    subRows.filter((r) => r.running).length +
    agentRows.filter((r) => r.running).length;

  const openStartModalForProfile = (row: RuntimeAgentStatus) => {
    setProfileSeed(row);
    form.setFieldsValue({
      task: '',
      label: row.label || row.profile_id || null,
      parent_agent_id: null,
      team_id: null,
      profile_id: row.profile_id || null,
    } as RuntimeSubagentStartBody);
    setStartModalOpen(true);
  };

  const openStartModalBlank = () => {
    setProfileSeed(null);
    form.resetFields();
    setStartModalOpen(true);
  };

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
          profile_id: values.profile_id || null,
        };
        startSubMutation.mutate(payload);
      })
      .catch(() => undefined);
  };

  const renderRoleTag = (row: RuntimeAgentStatus) => {
    if (row.role === 'main') {
      return (
        <Tag color="geekblue" icon={<ApiOutlined />}>
          {t('runtime.roleMain')}
        </Tag>
      );
    }
    if (row.role === 'agent') {
      return (
        <Tag color="green" icon={<RobotOutlined />}>
          {t('runtime.roleAgent')}
        </Tag>
      );
    }
    if (row.role === 'profile') {
      return (
        <Tag color="default" icon={<RobotOutlined />}>
          {t('runtime.roleProfile')}
        </Tag>
      );
    }
    return (
      <Tag color="purple" icon={<RobotOutlined />}>
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
      render: (_: unknown, row: RuntimeAgentStatus) => {
        const statusLabel =
          row.role === 'profile' && !row.running
            ? t('runtime.idle')
            : row.running
              ? t('runtime.running')
              : t('runtime.stopped');
        return (
          <Space direction="vertical" size={0}>
            <Tag color={phaseTagColor(row.phase, row.running)}>
              {statusLabel}
              {row.phase ? ` · ${row.phase}` : ''}
            </Tag>
            {row.iteration != null && (
              <Text type="secondary" className="text-xs">
                {t('runtime.iteration', { n: row.iteration })}
              </Text>
            )}
          </Space>
        );
      },
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
      width: 220,
      render: (_: unknown, row: RuntimeAgentStatus) => {
        const detailButton = (
          <Tooltip
            title={
              row.role === 'sub'
                ? t('runtime.viewDetail')
                : t('runtime.detailMainDisabled')
            }
          >
            <Button
              size="small"
              icon={<EyeOutlined />}
              onClick={() => setDetailRow(row)}
              disabled={row.role !== 'sub'}
            >
              {t('runtime.detail')}
            </Button>
          </Tooltip>
        );

        if (row.role === 'profile') {
          return (
            <Space size={4} wrap>
              <Button
                size="small"
                type="primary"
                icon={<PlayCircleOutlined />}
                onClick={() => openStartModalForProfile(row)}
                disabled={!mainRow}
              >
                {t('runtime.startProfile')}
              </Button>
            </Space>
          );
        }

        if (row.role === 'agent') {
          return (
            <Space size={4} wrap>
              <Tooltip title={t('runtime.disableHint')}>
                <Text type="secondary" className="text-xs">
                  {t('runtime.manageInAgentsPage')}
                </Text>
              </Tooltip>
            </Space>
          );
        }

        if (row.role === 'main') {
          return (
            <Space size={4} wrap>
              {detailButton}
              {row.running ? (
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
              )}
            </Space>
          );
        }
        return (
          <Space size={4} wrap>
            {detailButton}
            {row.running ? (
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
            ) : (
              <Text type="secondary" className="text-xs">{t('runtime.finished')}</Text>
            )}
          </Space>
        );
      },
    },
  ];

  return (
    <PageLayout embedded={embedded}>
      <div className="flex shrink-0 flex-col gap-4 border-b border-slate-200/90 pb-6 dark:border-slate-700/70 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className={PAGE_PRIMARY_TITLE_CLASS}>
            {t('runtime.title')}
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('runtime.subtitle')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
          <div className="inline-flex items-center rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 dark:border-blue-900/60 dark:bg-blue-900/20 dark:text-blue-300">
            {t('runtime.summary', {
              main: mainRow?.running ? t('runtime.running') : t('runtime.stopped'),
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
            onClick={openStartModalBlank}
            disabled={!mainRow}
          >
            <span className="hidden sm:inline">{t('runtime.startSub')}</span>
          </Button>
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
        title={
          profileSeed
            ? t('runtime.startProfileTitle', {
                label: profileSeed.label || profileSeed.profile_id || '',
              })
            : t('runtime.startSubTitle')
        }
        open={startModalOpen}
        onCancel={() => {
          setStartModalOpen(false);
          setProfileSeed(null);
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
              placeholder={
                profileSeed
                  ? t('runtime.startProfileTaskPlaceholder')
                  : t('runtime.fieldTaskPlaceholder')
              }
            />
          </Form.Item>
          <Form.Item label={t('runtime.fieldLabel')} name="label">
            <Input placeholder={t('runtime.fieldLabelPlaceholder')} />
          </Form.Item>
          <Form.Item
            label={t('runtime.fieldProfile')}
            name="profile_id"
            extra={t('runtime.fieldProfileExtra')}
          >
            <Input
              placeholder={profileSeed?.profile_id ?? ''}
              disabled={!!profileSeed}
            />
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

      <Drawer
        open={detailRow !== null}
        onClose={() => setDetailRow(null)}
        width={Math.min(720, typeof window !== 'undefined' ? window.innerWidth - 80 : 720)}
        title={
          detailRow ? (
            <Space size={8} className="flex-wrap">
              <Tag color="purple" icon={<RobotOutlined />}>
                {t('runtime.roleSub')}
              </Tag>
              <Text className="font-mono text-[12px]">{detailRow.agent_id}</Text>
              {detailRow.label && (
                <Text type="secondary" className="text-xs">
                  {detailRow.label}
                </Text>
              )}
            </Space>
          ) : (
            t('runtime.detailTitle')
          )
        }
        destroyOnClose
      >
        {detailRow ? (
          <Tabs
            items={[
              {
                key: 'transcript',
                label: t('runtime.transcriptTab'),
                children: (
                  <div className="space-y-3">
                    {detailRow.session_key ? (
                      <Text type="secondary" className="block text-xs">
                        {t('runtime.transcriptSessionKey')}:{' '}
                        <span className="font-mono">{detailRow.session_key}</span>
                      </Text>
                    ) : null}
                    {!detailSessionKey ? (
                      <Alert
                        type="info"
                        message={t('runtime.transcriptUnavailable')}
                        showIcon
                      />
                    ) : transcriptQuery.isLoading ? (
                      <div className="flex justify-center py-12">
                        <Spin />
                      </div>
                    ) : transcriptQuery.error ? (
                      <Alert
                        type="warning"
                        showIcon
                        message={t('runtime.transcriptLoadFailed')}
                        description={
                          transcriptQuery.error instanceof Error
                            ? transcriptQuery.error.message
                            : String(transcriptQuery.error)
                        }
                      />
                    ) : (transcriptQuery.data?.messages ?? []).length === 0 ? (
                      <Empty description={t('runtime.transcriptEmpty')} />
                    ) : (
                      <div className="max-h-[60vh] overflow-y-auto space-y-2 rounded-md border border-gray-200/80 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-900/40 p-3">
                        {(transcriptQuery.data?.messages ?? []).map((raw, idx) => {
                          const m = (raw ?? {}) as {
                            role?: string;
                            content?: unknown;
                            tool_calls?: unknown[];
                            tool_call_id?: string;
                            name?: string;
                            timestamp?: string;
                            metadata?: { event?: string } & Record<string, unknown>;
                          };
                          const role = m.role ?? 'system';
                          const text =
                            typeof m.content === 'string'
                              ? m.content
                              : m.content == null
                                ? ''
                                : JSON.stringify(m.content);
                          return (
                            <div
                              key={`${role}-${idx}`}
                              className="rounded-md bg-white/70 dark:bg-gray-800/60 p-2 text-xs space-y-1"
                            >
                              <div className="flex items-center justify-between">
                                <Tag
                                  color={
                                    role === 'user'
                                      ? 'blue'
                                      : role === 'assistant'
                                        ? 'green'
                                        : role === 'tool'
                                          ? 'orange'
                                          : 'default'
                                  }
                                  className="!m-0"
                                >
                                  {role}
                                  {m.name ? `:${m.name}` : ''}
                                  {m.metadata?.event ? `:${m.metadata.event}` : ''}
                                </Tag>
                                {m.timestamp && (
                                  <Text type="secondary" className="text-[10px]">
                                    {m.timestamp}
                                  </Text>
                                )}
                              </div>
                              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-gray-800 dark:text-gray-200 m-0">
                                {text || (m.tool_calls
                                  ? JSON.stringify(m.tool_calls, null, 2)
                                  : '')}
                              </pre>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ),
              },
              {
                key: 'status',
                label: t('runtime.statusTab'),
                children: (
                  <pre className="max-h-[60vh] overflow-y-auto rounded-md border border-gray-200/80 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-900/40 p-3 text-[11px] font-mono leading-relaxed">
                    {JSON.stringify(detailRow, null, 2)}
                  </pre>
                ),
              },
            ]}
          />
        ) : null}
      </Drawer>
    </PageLayout>
  );
}
