import { useState, useEffect, useMemo, type ComponentType } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Card,
  Spin,
  Empty,
  Tag,
  Button,
  Space,
  Timeline,
  Typography,
  Segmented,
  Badge,
} from 'antd';
import {
  ReloadOutlined,
  CodeOutlined,
  ApiOutlined,
  ClockCircleOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  AppstoreOutlined,
} from '@ant-design/icons';
import { Send, MessageCircle, AlertTriangle } from 'lucide-react';
import * as api from '../api/client';
import { useAppStore } from '../store';
import { getWSRef } from '../hooks/useWebSocket';
import { PageLayout } from '../components/PageLayout';
import { formatQueryError } from '../utils/errors';
import { useAgentTimeZone } from '../hooks/useAgentTimeZone';
import { formatAgentLocaleDate } from '../utils/agentDatetime';

const { Text } = Typography;

type ActivityIconComponent = ComponentType<{ className?: string }>;

const ACTIVITY_ICONS: Record<string, ActivityIconComponent> = {
  message: Send,
  tool_call: CodeOutlined,
  tool: CodeOutlined,
  channel: ApiOutlined,
  session: MessageCircle,
  error: AlertTriangle,
};

function ActivityIcon({ type }: { type: string }) {
  const Icon = ACTIVITY_ICONS[type] || MessageCircle;
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

export default function Activity() {
  const { t, i18n } = useTranslation();
  const { currentBotId } = useAppStore();
  const agentTz = useAgentTimeZone();
  const locale = i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US';
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');

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
            <AppstoreOutlined className="text-[15px] text-slate-500 dark:text-slate-400" />
            <span className="whitespace-nowrap">{t('activity.typeAll')}</span>
          </span>
        ),
      },
      {
        value: 'message',
        label: (
          <span className="flex items-center gap-1.5 sm:gap-2">
            <Send className="h-[15px] w-[15px] shrink-0 text-blue-500 opacity-90" />
            <span className="whitespace-nowrap">{t('activity.typeMessage')}</span>
          </span>
        ),
      },
      {
        value: 'tool_call',
        label: (
          <span className="flex items-center gap-1.5 sm:gap-2">
            <CodeOutlined className="text-[15px] text-violet-500 opacity-90" />
            <span className="whitespace-nowrap">{t('activity.typeToolCall')}</span>
          </span>
        ),
      },
      {
        value: 'channel',
        label: (
          <span className="flex items-center gap-1.5 sm:gap-2">
            <ApiOutlined className="text-[15px] text-cyan-600 dark:text-cyan-400 opacity-90" />
            <span className="whitespace-nowrap">{t('activity.typeChannel')}</span>
          </span>
        ),
      },
      {
        value: 'session',
        label: (
          <span className="flex items-center gap-1.5 sm:gap-2">
            <MessageCircle className="h-[15px] w-[15px] shrink-0 text-emerald-600 dark:text-emerald-400 opacity-90" />
            <span className="whitespace-nowrap">{t('activity.typeSession')}</span>
          </span>
        ),
      },
      {
        value: 'error',
        label: (
          <span className="flex items-center gap-1.5 sm:gap-2">
            <AlertTriangle className="h-[15px] w-[15px] shrink-0 text-red-500 opacity-90" />
            <span className="whitespace-nowrap">{t('activity.typeError')}</span>
          </span>
        ),
      },
    ],
    [t],
  );

  const { data: activities, isLoading, error, refetch } = useQuery({
    queryKey: ['activity', currentBotId, typeFilter],
    queryFn: () => api.getRecentActivity(100, currentBotId, typeFilter || undefined),
  });

  // Subscribe to the bot's activity room so live updates arrive via WebSocket.
  useEffect(() => {
    const ws = getWSRef()?.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'subscribe', room: `bot:${currentBotId}` }));
    return () => {
      ws.send(JSON.stringify({ type: 'unsubscribe', room: `bot:${currentBotId}` }));
    };
  }, [currentBotId]);

  const activityCounts = activities?.reduce(
    (acc, item) => {
      const t = item.type || 'unknown';
      acc[t] = (acc[t] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  const sortedActivities = activities
    ? [...activities].sort((a, b) => {
        const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return sortOrder === 'desc' ? timeB - timeA : timeA - timeB;
      })
    : [];

  if (isLoading && !activities) {
    return (
      <PageLayout variant="center">
        <Spin size="large" />
      </PageLayout>
    );
  }

  return (
    <PageLayout variant="bleed">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-2xl font-bold bg-gradient-to-r from-gray-900 to-gray-600 dark:from-white dark:to-gray-300 bg-clip-text text-transparent">
            {t('activity.title')}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {t('activity.subtitle')}
          </p>
        </div>
        <Space>
          <Badge status="processing" text={<span className="text-xs text-gray-400">{t('common.live')}</span>} />
          <Button icon={<ReloadOutlined />} onClick={() => refetch()}>
            {t('common.refresh')}
          </Button>
        </Space>
      </div>

      {/* Filters */}
      <div className="activity-filter-bar mt-5 shrink-0">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div className="min-w-0 flex-1 overflow-x-auto [-webkit-overflow-scrolling:touch] [scrollbar-width:thin]">
            <Segmented
              className="activity-type-segmented min-w-max"
              value={typeFilter}
              onChange={(val) => setTypeFilter(String(val))}
              options={activityTypeOptions}
            />
          </div>
          <div className="flex shrink-0 items-center gap-2 border-t border-slate-200/90 pt-3 dark:border-slate-600/80 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
            <Segmented
              className="activity-sort-segmented w-full sm:w-auto"
              value={sortOrder}
              onChange={(val) => setSortOrder(val as 'desc' | 'asc')}
              options={[
                {
                  value: 'desc',
                  label: (
                    <span className="flex items-center justify-center gap-1.5 px-0.5">
                      <ArrowDownOutlined className="text-sm" />
                      <span className="hidden md:inline">{t('activity.sortNewest')}</span>
                    </span>
                  ),
                },
                {
                  value: 'asc',
                  label: (
                    <span className="flex items-center justify-center gap-1.5 px-0.5">
                      <ArrowUpOutlined className="text-sm" />
                      <span className="hidden md:inline">{t('activity.sortOldest')}</span>
                    </span>
                  ),
                },
              ]}
            />
          </div>
        </div>
      </div>

      {/* Activity Counts */}
      {activityCounts && Object.keys(activityCounts).length > 0 && (
        <div className="flex flex-wrap gap-2 mt-4 shrink-0">
          {Object.entries(activityCounts).map(([type, count]) => (
            <Tag
              key={type}
              color={ACTIVITY_COLORS[type] || 'default'}
              className="flex items-center gap-1"
            >
              <ActivityIcon type={type} />
              {type}: {count}
            </Tag>
          ))}
        </div>
      )}

      {/* Activity List */}
      <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-y-auto">
        {error ? (
          <Card className="rounded-xl border border-red-200 dark:border-red-800">
            <Empty
              description={
                <span className="text-red-500">
                  {t('activity.loadFailed', { error: formatQueryError(error) })}
                </span>
              }
            />
          </Card>
        ) : activities && activities.length > 0 ? (
          <Card
            className="rounded-xl border border-gray-200/80 dark:border-gray-700/60 bg-white dark:bg-gray-800/40"
            styles={{ body: { padding: '1rem 1.5rem' } }}
          >
            <Timeline
              items={sortedActivities.map((item) => ({
                color: ACTIVITY_COLORS[item.type] || 'gray',
                icon: (
                  <div
                    className={`
                      w-8 h-8 rounded-lg flex items-center justify-center
                      ${
                        item.type === 'error'
                          ? 'bg-red-100 dark:bg-red-900/30 text-red-500'
                          : item.type === 'tool_call' || item.type === 'tool'
                          ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-500'
                          : item.type === 'message'
                          ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-500'
                          : item.type === 'channel'
                          ? 'bg-cyan-100 dark:bg-cyan-900/30 text-cyan-500'
                          : item.type === 'session'
                          ? 'bg-green-100 dark:bg-green-900/30 text-green-500'
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-500'
                      }
                    `}
                  >
                    <ActivityIcon type={item.type} />
                  </div>
                ),
                content: (
                  <div className="pb-4">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-gray-900 dark:text-gray-100">
                        {item.title}
                      </span>
                      <Tag
                        color={ACTIVITY_COLORS[item.type] || 'default'}
                        className="text-xs"
                      >
                        {item.type}
                      </Tag>
                    </div>
                    {item.description && (
                      <Text type="secondary" className="text-sm block mt-1">
                        {item.description}
                      </Text>
                    )}
                    <div className="flex items-center gap-1 mt-2 text-xs text-gray-400">
                      <ClockCircleOutlined />
                      <span>{formatTimeAgo(item.timestamp)}</span>
                    </div>
                  </div>
                ),
              }))}
            />
          </Card>
        ) : (
          <Card
            className="flex min-h-0 flex-1 flex-col rounded-xl border border-gray-200/80 dark:border-gray-700/60 [&_.ant-card-body]:flex [&_.ant-card-body]:min-h-0 [&_.ant-card-body]:flex-1 [&_.ant-card-body]:flex-col [&_.ant-card-body]:items-center [&_.ant-card-body]:justify-center"
          >
            <Empty description={t('activity.empty')} />
          </Card>
        )}
      </div>
    </PageLayout>
  );
}
