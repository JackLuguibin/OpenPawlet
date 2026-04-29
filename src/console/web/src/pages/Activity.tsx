import { useState, useEffect, useMemo, type ComponentType } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  Spin,
  Empty,
  Tag,
  Button,
  Space,
  Timeline,
  Typography,
  Segmented,
  Badge,
  Drawer,
  Pagination,
  Card,
} from 'antd';
import {
  SyncOutlined,
  ToolOutlined,
  ShareAltOutlined,
  FieldTimeOutlined,
  SortAscendingOutlined,
  SortDescendingOutlined,
  ClusterOutlined,
  CommentOutlined,
  ContainerOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons';
import * as api from '../api/client';
import { useAppStore } from '../store';
import { getWSRef } from '../hooks/useWebSocket';
import { PageLayout } from '../components/PageLayout';
import { PAGE_PRIMARY_TITLE_GRADIENT_CLASS } from '../utils/pageTitleClasses';
import { formatQueryError } from '../utils/errors';
import { useAgentTimeZone } from '../hooks/useAgentTimeZone';
import { formatAgentLocaleDate } from '../utils/agentDatetime';
import type { ActivityItem } from '../api/types';

const { Text, Paragraph } = Typography;

function formatActivityMetadata(meta: Record<string, unknown> | undefined): string {
  if (!meta || Object.keys(meta).length === 0) return '—';
  try {
    return JSON.stringify(meta, null, 2);
  } catch {
    return String(meta);
  }
}

type ActivityIconComponent = ComponentType<{ className?: string }>;

const ACTIVITY_ICONS: Record<string, ActivityIconComponent> = {
  message: CommentOutlined,
  tool_call: ToolOutlined,
  tool: ToolOutlined,
  channel: ShareAltOutlined,
  session: ContainerOutlined,
  error: ExclamationCircleOutlined,
};

function ActivityIcon({ type }: { type: string }) {
  const Icon = ACTIVITY_ICONS[type] || CommentOutlined;
  return <Icon className="text-lg" />;
}

const ACTIVITY_COLORS: Record<string, string> = {
  message: 'blue',
  tool_call: 'purple',
  tool: 'purple',
  channel: 'cyan',
  session: 'green',
  error: 'red',
};

export default function Activity({ embedded = false }: { embedded?: boolean } = {}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { currentBotId } = useAppStore();
  // Subscribe only after the console WS is OPEN; otherwise the effect would
  // no-op on mount and never rerun when the socket connects later.
  const wsConnected = useAppStore((s) => s.wsConnected);
  const agentTz = useAgentTimeZone();
  const locale = i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US';
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [detailItem, setDetailItem] = useState<ActivityItem | null>(null);

  const formatTimeAgo = (dateStr?: string): string => {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return t('common.justNow');
    if (minutes < 60) return t('common.minutesAgo', { count: minutes });
    if (hours < 24) return t('common.hoursAgo', { count: hours });
    if (days < 7) return t('common.daysAgo', { count: days });
    return formatAgentLocaleDate(date, agentTz, locale);
  };

  const activityTypeOptions = useMemo(
    () => [
      {
        value: '',
        label: (
          <span className="flex items-center gap-1.5 sm:gap-2">
            <ClusterOutlined className="text-[15px] text-slate-500 dark:text-slate-400" />
            <span className="whitespace-nowrap">{t('activity.typeAll')}</span>
          </span>
        ),
      },
      {
        value: 'message',
        label: (
          <span className="flex items-center gap-1.5 sm:gap-2">
            <CommentOutlined className="shrink-0 text-blue-500 opacity-90" />
            <span className="whitespace-nowrap">{t('activity.typeMessage')}</span>
          </span>
        ),
      },
      {
        value: 'tool_call',
        label: (
          <span className="flex items-center gap-1.5 sm:gap-2">
            <ToolOutlined className="text-[15px] text-violet-500 opacity-90" />
            <span className="whitespace-nowrap">{t('activity.typeToolCall')}</span>
          </span>
        ),
      },
      {
        value: 'channel',
        label: (
          <span className="flex items-center gap-1.5 sm:gap-2">
            <ShareAltOutlined className="text-[15px] text-cyan-600 dark:text-cyan-400 opacity-90" />
            <span className="whitespace-nowrap">{t('activity.typeChannel')}</span>
          </span>
        ),
      },
      {
        value: 'session',
        label: (
          <span className="flex items-center gap-1.5 sm:gap-2">
            <ContainerOutlined className="shrink-0 text-emerald-600 dark:text-emerald-400 opacity-90" />
            <span className="whitespace-nowrap">{t('activity.typeSession')}</span>
          </span>
        ),
      },
      {
        value: 'error',
        label: (
          <span className="flex items-center gap-1.5 sm:gap-2">
            <ExclamationCircleOutlined className="shrink-0 text-red-500 opacity-90" />
            <span className="whitespace-nowrap">{t('activity.typeError')}</span>
          </span>
        ),
      },
    ],
    [t],
  );

  const skip = (page - 1) * pageSize;

  const { data: activityFeed, isLoading, error, refetch } = useQuery({
    queryKey: ['activity', currentBotId, typeFilter, page, pageSize],
    queryFn: () =>
      api.getRecentActivity({
        botId: currentBotId,
        activityType: typeFilter || undefined,
        skip,
        limit: pageSize,
      }),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    setPage(1);
  }, [currentBotId, typeFilter]);

  // Subscribe to the bot's activity room so live updates arrive via WebSocket.
  // Depend on `wsConnected` so late-opening sockets still trigger (sub)scription.
  useEffect(() => {
    if (!currentBotId) return;
    if (!wsConnected) return;
    const ws = getWSRef()?.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const room = `bot:${currentBotId}`;
    ws.send(JSON.stringify({ type: 'subscribe', room }));
    return () => {
      // Guard the socket may already be closing on unmount.
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'unsubscribe', room }));
      }
    };
  }, [currentBotId, wsConnected]);

  const activityItems = activityFeed?.items ?? [];
  const activityHasMore = activityFeed?.has_more ?? false;
  /** Lower bound estimate for Pagination when more pages exist after this slice. */
  const paginationTotal = activityHasMore
    ? page * pageSize + 1
    : Math.max((page - 1) * pageSize + activityItems.length, 0);

  const activityCounts = activityItems.reduce(
    (acc, item) => {
      const tk = item.type || 'unknown';
      acc[tk] = (acc[tk] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  const pageCountBreakdownText = useMemo(() => {
    const entries = Object.entries(activityCounts).sort(([a], [b]) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' })
    );
    if (entries.length === 0) return '';
    return entries.map(([type, count]) => `${type}: ${count}`).join(' · ');
  }, [activityCounts]);

  const sortedActivities = [...activityItems].sort((a, b) => {
    const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return sortOrder === 'desc' ? timeB - timeA : timeA - timeB;
  });

  if (isLoading && !activityFeed) {
    return (
      <PageLayout variant="center" embedded={embedded}>
        <Spin size="large" />
      </PageLayout>
    );
  }

  const activityDetailTraceId =
    detailItem?.metadata &&
    typeof detailItem.metadata.trace_id === 'string' &&
    detailItem.metadata.trace_id
      ? detailItem.metadata.trace_id
      : '';

  return (
    <PageLayout variant="bleed" embedded={embedded} className="min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className={PAGE_PRIMARY_TITLE_GRADIENT_CLASS}>{t('activity.title')}</h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('activity.subtitle')}</p>
          </div>
          <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-2 sm:justify-end">
            <Badge
              status="processing"
              text={<span className="text-xs text-gray-400">{t('common.live')}</span>}
            />
            <Button
              icon={<SyncOutlined />}
              aria-label={t('common.refresh')}
              onClick={() => refetch()}
            >
              <span className="hidden sm:inline">{t('common.refresh')}</span>
            </Button>
          </div>
        </div>

        <Card
          className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-gray-200/90 shadow-sm dark:border-gray-700/80 dark:bg-gray-800/35"
          styles={{
            body: { padding: 0, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
          }}
        >
          <div
            className="shrink-0 border-b border-gray-100 bg-gray-50/40 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/20"
            role="search"
            aria-label={t('activity.subtitle')}
          >
            {!error && activityItems.length > 0 && pageCountBreakdownText ? (
              <div className="mb-2.5 text-xs leading-snug text-gray-500 dark:text-gray-400">
                {t('activity.pageStatsDetail', { count: activityItems.length, detail: pageCountBreakdownText })}
              </div>
            ) : null}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="min-w-0 flex-1 overflow-x-auto [-webkit-overflow-scrolling:touch] [scrollbar-width:thin]">
                <Segmented
                  className="min-w-max"
                  value={typeFilter}
                  onChange={(val) => setTypeFilter(String(val))}
                  options={activityTypeOptions}
                />
              </div>
              <div className="flex shrink-0 items-center gap-2 border-t border-gray-200/90 pt-3 dark:border-gray-600/80 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
                <Segmented
                  className="w-full sm:w-auto"
                  value={sortOrder}
                  onChange={(val) => setSortOrder(val as 'desc' | 'asc')}
                  options={[
                    {
                      value: 'desc',
                      label: (
                        <span className="flex items-center justify-center gap-1.5 px-0.5">
                          <SortDescendingOutlined className="text-sm" />
                          <span className="hidden md:inline">{t('activity.sortNewest')}</span>
                        </span>
                      ),
                    },
                    {
                      value: 'asc',
                      label: (
                        <span className="flex items-center justify-center gap-1.5 px-0.5">
                          <SortAscendingOutlined className="text-sm" />
                          <span className="hidden md:inline">{t('activity.sortOldest')}</span>
                        </span>
                      ),
                    },
                  ]}
                />
              </div>
            </div>
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain">
              {error ? (
                <div className="px-4 py-10">
                  <div className="rounded-md border border-red-200 px-4 py-6 dark:border-red-800">
                    <Empty
                      description={
                        <span className="text-red-500">
                          {t('activity.loadFailed', { error: formatQueryError(error) })}
                        </span>
                      }
                    />
                  </div>
                </div>
              ) : activityItems.length > 0 ? (
                <div className="min-w-0 px-3 pb-2 pt-1 pl-6 [&_.ant-timeline-item-content]:min-w-0 [&_.ant-timeline-item-content]:max-w-full">
                  {/* Extra left padding: Timeline rail uses negative inline margins; ancestors use overflow-hidden (Hub tabs). */}
                  <Timeline
                    items={sortedActivities.map((item) => {
                      const traceForObs =
                        typeof item.metadata?.trace_id === 'string' && item.metadata.trace_id
                          ? item.metadata.trace_id
                          : '';
                      return {
                        color: ACTIVITY_COLORS[item.type] || 'gray',
                        icon: (
                          <div
                            className={`flex items-center justify-center ${
                              item.type === 'error'
                                ? 'text-red-500'
                                : item.type === 'tool_call' || item.type === 'tool'
                                ? 'text-purple-500 dark:text-purple-400'
                                : item.type === 'message'
                                ? 'text-blue-500 dark:text-blue-400'
                                : item.type === 'channel'
                                ? 'text-cyan-600 dark:text-cyan-400'
                                : item.type === 'session'
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-gray-500 dark:text-gray-400'
                            }`}
                          >
                            <ActivityIcon type={item.type} />
                          </div>
                        ),
                        content: (
                          <div className="pb-4 min-w-0 max-w-full">
                            <div className="flex min-w-0 items-start gap-2 flex-wrap">
                              <span className="min-w-0 max-w-full break-words font-medium text-gray-900 dark:text-gray-100">
                                {item.title}
                              </span>
                              <Tag
                                color={ACTIVITY_COLORS[item.type] || 'default'}
                                className="shrink-0 text-xs"
                              >
                                {item.type}
                              </Tag>
                            </div>
                            {item.description ? (
                              <p
                                className="mb-0 mt-1 line-clamp-4 min-w-0 max-w-full text-sm leading-relaxed text-gray-500 [overflow-wrap:anywhere] break-words dark:text-gray-400"
                                title={item.description}
                              >
                                {item.description}
                              </p>
                            ) : null}
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2">
                              <div className="flex items-center gap-1 text-xs text-gray-400">
                                <FieldTimeOutlined />
                                <span>{formatTimeAgo(item.timestamp)}</span>
                              </div>
                              <Space size="small" wrap className="text-xs">
                                <Button
                                  type="link"
                                  size="small"
                                  className="px-0 h-auto"
                                  onClick={() => setDetailItem(item)}
                                >
                                  {t('activity.viewDetails')}
                                </Button>
                                {traceForObs ? (
                                  <Button
                                    type="link"
                                    size="small"
                                    className="px-0 h-auto"
                                    onClick={() =>
                                      navigate(`/traces?trace_id=${encodeURIComponent(traceForObs)}`, {
                                        state: { tracesReturnTo: '/activity' },
                                      })
                                    }
                                  >
                                    {t('activity.openInObservability')}
                                  </Button>
                                ) : null}
                              </Space>
                            </div>
                          </div>
                        ),
                      };
                    })}
                  />
                </div>
              ) : (
                <div className="flex min-h-[min(280px,50vh)] flex-1 flex-col items-center justify-center py-12">
                  <Empty description={t('activity.empty')} />
                </div>
              )}
            </div>

            {!error && (activityItems.length > 0 || activityHasMore || page > 1) ? (
              <div className="flex shrink-0 justify-end border-t border-gray-100 bg-gray-50/40 px-4 py-2.5 dark:border-gray-700 dark:bg-gray-800/20">
                <Pagination
                  className="!m-0"
                  size="small"
                  current={page}
                  pageSize={pageSize}
                  total={paginationTotal}
                  showSizeChanger
                  pageSizeOptions={[10, 20, 50, 100]}
                  showLessItems
                  onChange={(nextPage, nextSize) => {
                    if (nextSize !== pageSize) {
                      setPageSize(nextSize);
                      setPage(1);
                    } else {
                      setPage(nextPage);
                    }
                  }}
                />
              </div>
            ) : null}
          </div>
        </Card>
      </div>

      <Drawer
        title={t('activity.detailTitle')}
        placement="right"
        size={560}
        open={detailItem != null}
        onClose={() => setDetailItem(null)}
        destroyOnHidden
      >
        {detailItem ? (
          <div className="flex flex-col gap-3">
            <div>
              <Text strong className="text-gray-900 dark:text-gray-100">
                {detailItem.title}
              </Text>
              <Tag color={ACTIVITY_COLORS[detailItem.type] || 'default'} className="ml-2 align-middle text-xs">
                {detailItem.type}
              </Tag>
            </div>
            {detailItem.description ? (
              <Paragraph
                type="secondary"
                className="!mb-0 max-w-full text-sm [overflow-wrap:anywhere] break-words"
              >
                {detailItem.description}
              </Paragraph>
            ) : null}
            <Text type="secondary" className="text-xs block">
              {detailItem.timestamp}
            </Text>
            <Paragraph type="secondary" className="!mb-0 text-xs">
              {t('activity.detailHint')}
            </Paragraph>
            <pre className="max-h-[min(70vh,520px)] overflow-auto rounded-md border border-gray-200 bg-gray-50 p-3 text-xs dark:border-gray-600 dark:bg-gray-900/80">
              {formatActivityMetadata(detailItem.metadata as Record<string, unknown> | undefined)}
            </pre>
            {activityDetailTraceId ? (
              <Button
                type="primary"
                onClick={() => {
                  navigate(`/traces?trace_id=${encodeURIComponent(activityDetailTraceId)}`, {
                    state: { tracesReturnTo: '/activity' },
                  });
                  setDetailItem(null);
                }}
              >
                {t('activity.openInObservability')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </Drawer>
    </PageLayout>
  );
}
