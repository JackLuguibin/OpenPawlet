import { useState, useEffect, useMemo, type ComponentType } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Card,
  Spin,
  Empty,
  Tag,
  Button,
  Select,
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
} from '@ant-design/icons';
import { Send, MessageCircle, AlertTriangle } from 'lucide-react';
import * as api from '../api/client';
import { useAppStore } from '../store';
import { getWSRef } from '../hooks/useWebSocket';

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
  const { t } = useTranslation();
  const { currentBotId, setCurrentBotId } = useAppStore();
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc');

  const { data: bots } = useQuery({
    queryKey: ['bots'],
    queryFn: api.listBots,
  });

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
    return date.toLocaleDateString();
  };

  const activityTypeOptions = useMemo(
    () => [
      { value: '', label: t('activity.typeAll') },
      { value: 'message', label: t('activity.typeMessage') },
      { value: 'tool_call', label: t('activity.typeToolCall') },
      { value: 'channel', label: t('activity.typeChannel') },
      { value: 'session', label: t('activity.typeSession') },
      { value: 'error', label: t('activity.typeError') },
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
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div className="p-6 flex flex-col flex-1 min-h-0">
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
          {bots && bots.length > 1 && (
            <Select
              value={currentBotId || bots.find((b) => b.is_default)?.id || bots[0]?.id}
              onChange={setCurrentBotId}
              options={bots.map((b) => ({ label: b.name, value: b.id }))}
              className="w-40"
            />
          )}
          <Badge status="processing" text={<span className="text-xs text-gray-400">{t('common.live')}</span>} />
          <Button icon={<ReloadOutlined />} onClick={() => refetch()}>
            {t('common.refresh')}
          </Button>
        </Space>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4 mt-4 shrink-0">
        <Segmented
          className="activity-seg-align"
          value={typeFilter}
          onChange={(val) => setTypeFilter(String(val))}
          options={activityTypeOptions}
        />
        <Segmented
          value={sortOrder}
          onChange={(val) => setSortOrder(val as 'desc' | 'asc')}
          options={[
            { value: 'desc', label: <ArrowDownOutlined /> },
            { value: 'asc', label: <ArrowUpOutlined /> },
          ]}
        />
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
                  {t('activity.loadFailed', { error: String(error) })}
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
    </div>
  );
}
