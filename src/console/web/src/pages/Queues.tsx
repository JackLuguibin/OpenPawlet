import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Input,
  Select,
  Space,
  Spin,
  Statistic,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  App as AntdApp,
} from 'antd';
import {
  DeploymentUnitOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  DeleteOutlined,
  RollbackOutlined,
} from '@ant-design/icons';
import {
  ConsolePageShell,
  ConsolePageHeading,
} from '../components/ConsolePageChrome';
import { PageLayout } from '../components/PageLayout';
import { PAGE_PRIMARY_TITLE_ANT_TITLE_CLASS } from '../utils/pageTitleClasses';
import * as api from '../api/client';
import type {
  QueueConnectionInfo,
  QueueSampleInfo,
  QueueSnapshot,
} from '../api/client';
import { useQueuesStream } from '../hooks/useQueuesStream';

const { Title, Text } = Typography;

/** Consistent card surface (matches other console management pages) */
const QUEUE_CARD_CLS =
  'shadow-sm dark:border-gray-700/80 dark:bg-gray-900/20 [&_.ant-card-head]:min-h-12';

function formatTs(sec: number): string {
  if (!sec) return '-';
  const d = new Date(sec * 1000);
  return d.toLocaleTimeString();
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}h ${m}m ${ss}s`;
  if (m > 0) return `${m}m ${ss}s`;
  return `${ss}s`;
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let b = bytes;
  while (b >= 1024 && i < units.length - 1) {
    b /= 1024;
    i += 1;
  }
  return `${b.toFixed(b >= 10 ? 0 : 1)} ${units[i]}`;
}

export default function Queues({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useTranslation();
  const { message: messageApi, modal: modalApi } = AntdApp.useApp();
  const qc = useQueryClient();

  const {
    data: snapshot,
    isLoading,
    error,
    refetch,
  } = useQuery<QueueSnapshot>({
    queryKey: ['queues-snapshot'],
    queryFn: api.getQueueSnapshot,
    // Polling fallback in case the WebSocket is down; broker push fills in faster.
    refetchInterval: 10_000,
  });

  const [streamEnabled, setStreamEnabled] = useState(true);
  const [sampleSubscribed, setSampleSubscribed] = useState(false);
  const { tick, connected, error: wsError, subscribe, unsubscribe, reconnect } =
    useQueuesStream(streamEnabled);

  // Merge the polled snapshot with the streaming tick so we always show the
  // freshest counters while keeping the baseline topology/samples from the
  // initial fetch.
  const merged = useMemo<QueueSnapshot | undefined>(() => {
    if (!snapshot) return undefined;
    if (!tick) return snapshot;
    return {
      ...snapshot,
      metrics: { ...snapshot.metrics, ...tick.metrics },
      rates: { ...snapshot.rates, ...tick.rates },
      paused: tick.paused ?? snapshot.paused,
      connections: tick.connections ?? snapshot.connections,
      dedupe: tick.dedupe ?? snapshot.dedupe,
      samples: tick.samples ?? snapshot.samples,
    };
  }, [snapshot, tick]);

  const pauseMutation = useMutation({
    mutationFn: ({
      direction,
      paused,
    }: {
      direction: 'inbound' | 'outbound' | 'events' | 'both' | 'all';
      paused: boolean;
    }) => api.pauseQueue(direction, paused),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queues-snapshot'] });
      messageApi.success(t('queues.pauseApplied'));
    },
    onError: (e: unknown) => {
      messageApi.error((e as Error)?.message || 'pause failed');
    },
  });

  const replayMutation = useMutation({
    mutationFn: (messageId: string) => api.replayQueueMessage(messageId),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['queues-snapshot'] });
      messageApi.success(
        `${t('queues.replayOk')}: ${result.message_id} (${result.direction})`,
      );
    },
    onError: (e: unknown) => {
      messageApi.error((e as Error)?.message || 'replay failed');
    },
  });

  const clearMutation = useMutation({
    mutationFn: (scope: 'memory' | 'persist' | 'both') =>
      api.clearQueueDedupe(scope),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['queues-snapshot'] });
      messageApi.success(
        `${t('queues.clearOk')}: memory=${result.memory_cleared}, persist_bytes=${result.persist_bytes_cleared}`,
      );
    },
    onError: (e: unknown) => {
      messageApi.error((e as Error)?.message || 'clear failed');
    },
  });

  const confirmPause = (
    direction: 'inbound' | 'outbound' | 'events' | 'both' | 'all',
    paused: boolean,
  ) => {
    modalApi.confirm({
      title: t(paused ? 'queues.confirmPause' : 'queues.confirmResume'),
      content: `direction=${direction}`,
      okType: paused ? 'danger' : 'primary',
      onOk: () => pauseMutation.mutateAsync({ direction, paused }),
    });
  };

  const confirmReplay = (messageId: string) => {
    modalApi.confirm({
      title: t('queues.confirmReplay'),
      content: messageId,
      okType: 'primary',
      onOk: () => replayMutation.mutateAsync(messageId),
    });
  };

  const confirmClear = (scope: 'memory' | 'persist' | 'both') => {
    modalApi.confirm({
      title: t('queues.confirmClear'),
      content: `scope=${scope}`,
      okType: 'danger',
      onOk: () => clearMutation.mutateAsync(scope),
    });
  };

  if (isLoading && !snapshot) {
    return (
      <PageLayout variant="center" embedded={embedded}>
        <Spin size="large" />
      </PageLayout>
    );
  }

  if (error || !merged) {
    return (
      <PageLayout embedded={embedded}>
        <Alert
          type="error"
          title={t('queues.loadFailed')}
          description={(error as Error)?.message}
          showIcon
          action={
            <Button
              onClick={() => refetch()}
              icon={<ReloadOutlined />}
              aria-label={t('queues.retry')}
            >
              <span className="hidden sm:inline">{t('queues.retry')}</span>
            </Button>
          }
        />
      </PageLayout>
    );
  }

  const topologyRows = Object.entries(merged.topology).map(([name, info]) => ({
    key: name,
    name,
    ...info,
    connections: merged.connections.filter((c) => c.socket === name).length,
  }));

  const queuesHeading = (
    <div className="flex min-w-0 items-start gap-3">
      <div
        className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-sky-100 dark:bg-sky-950/50"
        aria-hidden
      >
        <DeploymentUnitOutlined className="text-sky-600 dark:text-sky-400" style={{ fontSize: 18 }} />
      </div>
      <div className="min-w-0">
        <Title level={3} className={PAGE_PRIMARY_TITLE_ANT_TITLE_CLASS}>
          {t('queues.title')}
        </Title>
        <Text type="secondary" className="text-sm">
          {t('queues.subtitle')}
        </Text>
      </div>
    </div>
  );

  const queuesToolbar = (
    <Space wrap size="small" className="w-full shrink-0 justify-end sm:w-auto sm:pt-0.5">
      <Tag color={connected ? 'success' : 'default'}>
        {connected ? t('queues.wsOn') : t('queues.wsOff')}
      </Tag>
      <Switch
        checked={streamEnabled}
        onChange={setStreamEnabled}
        checkedChildren={t('queues.streamOn')}
        unCheckedChildren={t('queues.streamOff')}
      />
      <Button
        icon={<ReloadOutlined />}
        aria-label={t('queues.refresh')}
        onClick={() => {
          refetch();
          reconnect();
        }}
      >
        <span className="hidden sm:inline">{t('queues.refresh')}</span>
      </Button>
    </Space>
  );

  return (
    <ConsolePageShell embedded={embedded}>
      <ConsolePageHeading
        surface={embedded ? 'plain' : 'hero'}
        rowGapClass="gap-3 sm:gap-4"
        heading={queuesHeading}
        extra={queuesToolbar}
      />

      {wsError && (
        <Alert
          type="warning"
          showIcon
          title={wsError}
          className="shrink-0"
        />
      )}

      <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-6 overflow-y-auto overflow-x-hidden pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
            <Card
              className={`${QUEUE_CARD_CLS} h-full`}
              classNames={{ body: 'h-full' }}
            >
              <Statistic
                title={t('queues.uptime')}
                value={formatDuration(merged.uptime_s)}
              />
              <Text type="secondary" className="text-xs">
                v{merged.version}
              </Text>
            </Card>
            <Card
              className={`${QUEUE_CARD_CLS} h-full`}
              classNames={{ body: 'h-full' }}
            >
              <Statistic
                title={t('queues.inboundRate')}
                value={merged.rates.inbound_forwarded ?? 0}
                suffix="/s"
                precision={2}
              />
              <Text type="secondary" className="text-xs">
                {t('queues.total')}: {merged.metrics.inbound_forwarded ?? 0}
              </Text>
            </Card>
            <Card
              className={`${QUEUE_CARD_CLS} h-full`}
              classNames={{ body: 'h-full' }}
            >
              <Statistic
                title={t('queues.outboundRate')}
                value={merged.rates.outbound_forwarded ?? 0}
                suffix="/s"
                precision={2}
              />
              <Text type="secondary" className="text-xs">
                {t('queues.total')}: {merged.metrics.outbound_forwarded ?? 0}
              </Text>
            </Card>
            <Card
              className={`${QUEUE_CARD_CLS} h-full`}
              classNames={{ body: 'h-full' }}
            >
              <Statistic
                title={t('queues.dedupeSize')}
                value={merged.dedupe.size}
              />
              <Text type="secondary" className="text-xs block mt-0.5">
                {t('queues.dedupeHits')}: {merged.dedupe.hits} · {t('queues.dedupeMisses')}:{' '}
                {merged.dedupe.misses}
              </Text>
            </Card>
          </div>

          <Card className={QUEUE_CARD_CLS} title={t('queues.topologyTitle')}>
            <Table<(typeof topologyRows)[number]>
              size="small"
              pagination={false}
              dataSource={topologyRows}
              scroll={{ x: 'max-content' }}
              className="queues-table"
              columns={[
                { title: t('queues.socket'), dataIndex: 'name', key: 'name', ellipsis: true },
                { title: t('queues.role'), dataIndex: 'role', key: 'role', ellipsis: true },
                { title: t('queues.bind'), dataIndex: 'bind', key: 'bind', ellipsis: true },
                {
                  title: t('queues.connectHint'),
                  dataIndex: 'connect_hint',
                  key: 'connect_hint',
                  ellipsis: true,
                },
                {
                  title: t('queues.connectionCount'),
                  dataIndex: 'connections',
                  key: 'connections',
                  width: 120,
                  render: (v: number) => <Tag color={v > 0 ? 'blue' : 'default'}>{v}</Tag>,
                },
              ]}
            />
          </Card>

          <Card className={QUEUE_CARD_CLS} title={t('queues.adminTitle')} size="small">
            <Alert
              type="info"
              showIcon
              className="mb-3"
              title="In-process bus: pause / replay / dedupe controls are read-only in this layout (server returns 410 Gone)."
            />
            <Descriptions
              size="small"
              bordered
              column={{ xs: 1, sm: 2, md: 3 }}
              labelStyle={{ width: 140, whiteSpace: 'nowrap' }}
            >
              <Descriptions.Item label={t('queues.brokerHost')}>
                <Text code className="text-xs sm:text-sm">
                  {merged.settings.host}
                </Text>
              </Descriptions.Item>
              <Descriptions.Item label={t('queues.adminEndpoint')}>
                <Text code className="text-xs sm:text-sm break-all">
                  {`${merged.settings.health_host}:${merged.settings.health_port}`}
                </Text>
              </Descriptions.Item>
              <Descriptions.Item label={t('queues.adminToken')}>
                {merged.settings.admin_token_configured ? (
                  <Tag color="green">{t('queues.adminTokenSet')}</Tag>
                ) : (
                  <Tag color="orange">{t('queues.adminTokenUnset')}</Tag>
                )}
              </Descriptions.Item>
              <Descriptions.Item label={t('queues.sampleCapacity')}>
                {merged.settings.sample_capacity}
              </Descriptions.Item>
              <Descriptions.Item label={t('queues.dedupeWindow')}>
                {merged.settings.idempotency_window_seconds}s
              </Descriptions.Item>
              <Descriptions.Item label={t('queues.dedupePersist')}>
                {formatBytes(merged.dedupe.persist_size)}
              </Descriptions.Item>
            </Descriptions>
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              <Card
                size="small"
                title={t('queues.pauseTitle')}
                className="border-gray-200/90 bg-gray-50/50 dark:border-gray-700/60 dark:bg-gray-800/30"
              >
                {/* In-process bus: pause/resume is server-side disabled (410 Gone). */}
                <div className="flex flex-col gap-2 opacity-60 pointer-events-none">
                  <div className="flex items-center justify-between gap-2 rounded-md border border-gray-200/80 bg-white px-3 py-2 dark:border-gray-600/50 dark:bg-gray-900/40">
                    <Text strong className="shrink-0">
                      {t('queues.inbound')}
                    </Text>
                    {merged.paused.inbound ? (
                      <Button
                        icon={<PlayCircleOutlined />}
                        onClick={() => confirmPause('inbound', false)}
                        size="small"
                      >
                        {t('queues.resume')}
                      </Button>
                    ) : (
                      <Button
                        danger
                        icon={<PauseCircleOutlined />}
                        onClick={() => confirmPause('inbound', true)}
                        size="small"
                      >
                        {t('queues.pause')}
                      </Button>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-2 rounded-md border border-gray-200/80 bg-white px-3 py-2 dark:border-gray-600/50 dark:bg-gray-900/40">
                    <Text strong className="shrink-0">
                      {t('queues.outbound')}
                    </Text>
                    {merged.paused.outbound ? (
                      <Button
                        icon={<PlayCircleOutlined />}
                        onClick={() => confirmPause('outbound', false)}
                        size="small"
                      >
                        {t('queues.resume')}
                      </Button>
                    ) : (
                      <Button
                        danger
                        icon={<PauseCircleOutlined />}
                        onClick={() => confirmPause('outbound', true)}
                        size="small"
                      >
                        {t('queues.pause')}
                      </Button>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-2 rounded-md border border-gray-200/80 bg-white px-3 py-2 dark:border-gray-600/50 dark:bg-gray-900/40">
                    <Text strong className="shrink-0">
                      {t('queues.events')}
                    </Text>
                    {merged.paused.events ? (
                      <Button
                        icon={<PlayCircleOutlined />}
                        onClick={() => confirmPause('events', false)}
                        size="small"
                      >
                        {t('queues.resume')}
                      </Button>
                    ) : (
                      <Button
                        danger
                        icon={<PauseCircleOutlined />}
                        onClick={() => confirmPause('events', true)}
                        size="small"
                      >
                        {t('queues.pause')}
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
              <Card
                size="small"
                title={t('queues.dedupeClearTitle')}
                className="border-gray-200/90 bg-gray-50/50 dark:border-gray-700/60 dark:bg-gray-800/30"
              >
                {/* In-process bus: replay + dedupe clear are server-side disabled (410 Gone). */}
                <div className="opacity-60 pointer-events-none">
                  <ReplayAndClearForm
                    onReplay={confirmReplay}
                    onClear={confirmClear}
                  />
                </div>
              </Card>
            </div>
          </Card>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2 xl:items-start">
            <Card
              className={QUEUE_CARD_CLS}
              title={t('queues.connectionsTitle')}
              extra={
                <Tag>
                  {merged.connections.length} {t('queues.connectionsSuffix')}
                </Tag>
              }
            >
              <Table<QueueConnectionInfo>
                size="small"
                pagination={{ pageSize: 8, size: 'small', showSizeChanger: false }}
                dataSource={merged.connections.map((c, idx) => ({
                  ...c,
                  key: `${c.socket}:${c.peer}:${idx}`,
                }))}
                scroll={{ x: 'max-content' }}
                className="queues-table"
                columns={[
                  { title: t('queues.socket'), dataIndex: 'socket', key: 'socket', ellipsis: true },
                  { title: t('queues.peer'), dataIndex: 'peer', key: 'peer', ellipsis: true },
                  {
                    title: t('queues.lastEvent'),
                    dataIndex: 'last_event',
                    key: 'last_event',
                    width: 120,
                    render: (v: string) => <Tag className="max-w-[8rem] truncate">{v}</Tag>,
                  },
                  {
                    title: t('queues.lastEventAt'),
                    dataIndex: 'last_event_at',
                    key: 'last_event_at',
                    width: 100,
                    render: (v: number) => formatTs(v),
                  },
                  {
                    title: t('queues.eventCount'),
                    dataIndex: 'event_count',
                    key: 'event_count',
                    width: 80,
                    align: 'right',
                  },
                ]}
              />
            </Card>

            <Card
              className={QUEUE_CARD_CLS}
              title={t('queues.samplesTitle')}
              extra={
                <Space size="small">
                  <Switch
                    checked={sampleSubscribed}
                    onChange={(v) => {
                      setSampleSubscribed(v);
                      if (v) {
                        subscribe(['samples']);
                      } else {
                        unsubscribe(['samples']);
                      }
                    }}
                    checkedChildren={t('queues.streamSamplesOn')}
                    unCheckedChildren={t('queues.streamSamplesOff')}
                  />
                </Space>
              }
            >
              <Table<QueueSampleInfo>
                size="small"
                pagination={{ pageSize: 8, size: 'small', showSizeChanger: false }}
                dataSource={merged.samples.map((s, idx) => ({
                  ...s,
                  key: `${s.message_id}:${idx}`,
                }))}
                scroll={{ x: 'max-content' }}
                className="queues-table"
                columns={[
                  {
                    title: t('queues.sampleAt'),
                    dataIndex: 'at',
                    key: 'at',
                    width: 96,
                    render: (v: number) => formatTs(v),
                  },
                  {
                    title: t('queues.direction'),
                    dataIndex: 'direction',
                    key: 'direction',
                    width: 100,
                    render: (v: string) => {
                      const color =
                        v === 'inbound'
                          ? 'blue'
                          : v === 'outbound'
                            ? 'green'
                            : v === 'events'
                              ? 'purple'
                              : 'default';
                      const label =
                        v === 'inbound'
                          ? t('queues.inbound')
                          : v === 'outbound'
                            ? t('queues.outbound')
                            : v === 'events'
                              ? t('queues.events')
                              : v;
                      return <Tag color={color}>{label}</Tag>;
                    },
                  },
                  {
                    title: 'kind',
                    dataIndex: 'kind',
                    key: 'kind',
                    width: 88,
                    ellipsis: true,
                  },
                  {
                    title: 'message_id',
                    dataIndex: 'message_id',
                    key: 'message_id',
                    ellipsis: true,
                    render: (v: string) => (
                      <Tooltip title={v}>
                        <span className="font-mono text-xs">{v}</span>
                      </Tooltip>
                    ),
                  },
                  {
                    title: 'session_key',
                    dataIndex: 'session_key',
                    key: 'session_key',
                    ellipsis: true,
                    render: (v: string) => (
                      <Tooltip title={v || '-'}>
                        <span className="font-mono text-xs">{v || '—'}</span>
                      </Tooltip>
                    ),
                  },
                  {
                    title: t('queues.bytes'),
                    dataIndex: 'bytes',
                    key: 'bytes',
                    width: 88,
                    align: 'right',
                    render: (v: number) => formatBytes(v),
                  },
                  {
                    title: t('queues.actions'),
                    key: 'actions',
                    width: 88,
                    fixed: 'right' as const,
                    render: (_: unknown, row: QueueSampleInfo) => (
                      <Tooltip title={t('queues.replayHint')}>
                        <Button
                          type="link"
                          size="small"
                          className="!px-1"
                          icon={<RollbackOutlined />}
                          onClick={() => confirmReplay(row.message_id)}
                        >
                          {t('queues.replay')}
                        </Button>
                      </Tooltip>
                    ),
                  },
                ]}
              />
            </Card>
          </div>
      </div>
    </ConsolePageShell>
  );
}

function ReplayAndClearForm({
  onReplay,
  onClear,
}: {
  onReplay: (messageId: string) => void;
  onClear: (scope: 'memory' | 'persist' | 'both') => void;
}) {
  const { t } = useTranslation();
  const [mid, setMid] = useState('');
  const [scope, setScope] = useState<'memory' | 'persist' | 'both'>('memory');
  return (
    <Space orientation="vertical" className="w-full">
      <Space.Compact className="w-full">
        <Input
          placeholder={t('queues.messageIdPlaceholder')}
          value={mid}
          onChange={(e) => setMid(e.target.value)}
          allowClear
        />
        <Button
          type="primary"
          icon={<RollbackOutlined />}
          disabled={!mid.trim()}
          onClick={() => onReplay(mid.trim())}
        >
          {t('queues.replay')}
        </Button>
      </Space.Compact>
      <Space.Compact className="w-full">
        <Select<typeof scope>
          value={scope}
          onChange={setScope}
          options={[
            { label: 'memory', value: 'memory' },
            { label: 'persist', value: 'persist' },
            { label: 'both', value: 'both' },
          ]}
          style={{ minWidth: 120 }}
        />
        <Button
          danger
          icon={<DeleteOutlined />}
          onClick={() => onClear(scope)}
        >
          {t('queues.clearDedupe')}
        </Button>
      </Space.Compact>
    </Space>
  );
}
