import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useAppStore } from '../store';
import * as api from '../api/client';
import {
  Card,
  Statistic,
  Button,
  Tag,
  Badge,
  Spin,
  Alert,
  Space,
  Typography,
  Modal,
} from 'antd';
import {
  ReloadOutlined,
  PoweroffOutlined,
  SyncOutlined,
  ClockCircleOutlined,
  TeamOutlined,
  MessageOutlined,
  DollarOutlined,
  ThunderboltOutlined,
  BarChartOutlined,
} from '@ant-design/icons';
import { Column, Tiny, Pie } from '@ant-design/plots';
import type { UsageHistoryItem } from '../api/types';
import { formatTokenCount, formatCost } from '../utils/format';

const { Text } = Typography;

/** 将 usageHistory 转为柱状图分组数据 */
function toColumnData(history: UsageHistoryItem[], t: TFunction) {
  const prompt = t('dashboard.chartPrompt');
  const completion = t('dashboard.chartCompletion');
  return history.flatMap((d) => [
    { date: d.date, type: prompt, value: d.prompt_tokens ?? 0 },
    { date: d.date, type: completion, value: d.completion_tokens ?? 0 },
  ]);
}

function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export default function Dashboard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { setStatus, setChannels, setMCPServers, status, addToast, currentBotId } = useAppStore();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['status', currentBotId],
    queryFn: () => api.getStatus(currentBotId),
    refetchInterval: false,
  });

  const { data: bots = [] } = useQuery({
    queryKey: ['bots'],
    queryFn: api.listBots,
  });

  const { data: usageHistory, isLoading: usageLoading } = useQuery({
    queryKey: ['usage-history', currentBotId],
    queryFn: () => api.getUsageHistory(currentBotId, 14),
    refetchInterval: false,
  });

  // 用当前 bot 的 API 数据作为展示源，避免与 store 中其他 bot 或旧数据混用
  const displayStatus = data ?? status;

  useEffect(() => {
    if (data) {
      setStatus(data);
      setChannels(data.channels || []);
      setMCPServers(data.mcp_servers || []);
    }
  }, [data, setStatus, setChannels, setMCPServers]);

  const stopMutation = useMutation({
    mutationFn: () => {
      const botId =
        currentBotId || bots.find((b) => b.is_default)?.id || bots[0]?.id;
      if (!botId) {
        return Promise.reject(new Error(t('dashboard.botRequired')));
      }
      return api.stopBot(botId);
    },
    onSuccess: () => {
      addToast({ type: 'success', message: t('dashboard.toastStopped') });
      queryClient.invalidateQueries({ queryKey: ['status'] });
      queryClient.invalidateQueries({ queryKey: ['bots'] });
      queryClient.invalidateQueries({ queryKey: ['usage-history', currentBotId] });
    },
    onError: (error) => {
      addToast({ type: 'error', message: String(error) });
    },
  });

  const restartMutation = useMutation({
    mutationFn: async () => {
      const botId =
        currentBotId || bots.find((b) => b.is_default)?.id || bots[0]?.id;
      if (!botId) {
        return Promise.reject(new Error(t('dashboard.botRequired')));
      }
      await api.stopBot(botId);
      await api.startBot(botId);
    },
    onSuccess: () => {
      addToast({ type: 'success', message: t('dashboard.toastRestartOk') });
      queryClient.invalidateQueries({ queryKey: ['status'] });
      queryClient.invalidateQueries({ queryKey: ['bots'] });
      queryClient.invalidateQueries({ queryKey: ['usage-history', currentBotId] });
    },
    onError: (error) => {
      addToast({ type: 'error', message: String(error) });
    },
  });

  const handleRestart = () => {
    Modal.confirm({
      title: t('dashboard.restartTitle'),
      content: t('dashboard.restartContent'),
      okText: t('dashboard.restartOk'),
      onOk: () => restartMutation.mutate(),
    });
  };

  if (isLoading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <Spin size="large" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col p-6">
        <Alert
          type="error"
          message={t('dashboard.loadError')}
          description={String(error)}
          showIcon
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold bg-gradient-to-r from-gray-900 to-gray-600 dark:from-white dark:to-gray-300 bg-clip-text text-transparent">
            {t('dashboard.title')}
          </h1>
          <p className="text-sm text-gray-500 mt-1">{t('dashboard.subtitle')}</p>
        </div>
        <Space>
          {displayStatus?.running && (
            <Button
              danger
              icon={<PoweroffOutlined />}
              loading={stopMutation.isPending}
              onClick={() => stopMutation.mutate()}
            >
              <span className="hidden sm:inline">{t('dashboard.stop')}</span>
            </Button>
          )}
          <Button
            icon={<SyncOutlined />}
            loading={restartMutation.isPending}
            onClick={handleRestart}
          >
            <span className="hidden sm:inline">{t('dashboard.restart')}</span>
          </Button>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              refetch();
              queryClient.invalidateQueries({ queryKey: ['usage-history', currentBotId] });
            }}
          />
        </Space>
      </div>

      {/* Stat Cards：统一高度与数值区对齐；小屏 2 列、中屏 3 列、大屏 6 列，避免窄屏横向溢出 */}
      <div
        className="grid shrink-0 grid-cols-2 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 sm:gap-4 min-w-0 [&_.ant-statistic-title]:min-h-[20px] [&_.ant-statistic-title]:text-xs [&_.ant-statistic-content]:min-h-[40px] [&_.ant-statistic-content]:flex [&_.ant-statistic-content]:items-end [&_.ant-statistic-content-value]:text-lg [&_.ant-statistic-content-value]:xl:text-2xl"
      >
        <Card hoverable className="h-full min-w-0 [&_.ant-card-body]:flex [&_.ant-card-body]:flex-col [&_.ant-card-body]:h-full [&_.ant-card-body]:min-w-0">
          <Statistic
            title={t('dashboard.statStatus')}
            value={displayStatus?.running ? t('dashboard.statRunning') : t('dashboard.statStopped')}
            styles={{ content: { color: displayStatus?.running ? '#16a34a' : '#9ca3af' } }}
            prefix={
              displayStatus?.running ? (
                <Badge status="processing" color="#22c55e" />
              ) : (
                <Badge status="default" />
              )
            }
          />
        </Card>
        <Card hoverable className="h-full min-w-0 [&_.ant-card-body]:flex [&_.ant-card-body]:flex-col [&_.ant-card-body]:h-full [&_.ant-card-body]:min-w-0">
          <Statistic
            title={t('dashboard.statUptime')}
            value={displayStatus?.running && displayStatus?.uptime_seconds ? formatUptime(displayStatus.uptime_seconds) : '-'}
            prefix={<ClockCircleOutlined className="text-blue-500" />}
          />
        </Card>
        <Card hoverable className="h-full min-w-0 [&_.ant-card-body]:flex [&_.ant-card-body]:flex-col [&_.ant-card-body]:h-full [&_.ant-card-body]:min-w-0">
          <Statistic
            title={t('dashboard.statActiveSessions')}
            value={displayStatus?.active_sessions ?? 0}
            prefix={<TeamOutlined className="text-purple-500" />}
          />
        </Card>
        <Card hoverable className="h-full min-w-0 [&_.ant-card-body]:flex [&_.ant-card-body]:flex-col [&_.ant-card-body]:h-full [&_.ant-card-body]:min-w-0">
          <Statistic
            title={t('dashboard.statMessagesToday')}
            value={displayStatus?.messages_today ?? 0}
            prefix={<MessageOutlined className="text-orange-500" />}
          />
        </Card>
        <Card hoverable className="h-full min-w-0 [&_.ant-card-body]:flex [&_.ant-card-body]:flex-col [&_.ant-card-body]:h-full [&_.ant-card-body]:min-w-0">
          <Statistic
            title={t('dashboard.statTokensToday')}
            value={
              displayStatus?.token_usage?.total_tokens != null
                ? formatTokenCount(displayStatus.token_usage.total_tokens)
                : '-'
            }
            prefix={<ThunderboltOutlined className="text-amber-500" />}
          />
        </Card>
        <Card hoverable className="h-full min-w-0 [&_.ant-card-body]:flex [&_.ant-card-body]:flex-col [&_.ant-card-body]:h-full [&_.ant-card-body]:min-w-0">
          <Statistic
            title={t('dashboard.statCostToday')}
            value={
              displayStatus?.token_usage?.cost_usd != null && displayStatus.token_usage.cost_usd > 0
                ? formatCost(displayStatus.token_usage.cost_usd)
                : '-'
            }
            prefix={<DollarOutlined className="text-green-500" />}
          />
        </Card>
      </div>

      {/* Model Info & Token Usage */}
      {displayStatus?.model && (
        <Card size="small" className="shrink-0">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-blue-100 dark:bg-blue-900/30">
                <ThunderboltOutlined className="text-blue-600 text-lg" />
              </div>
              <div>
                <Text type="secondary" className="text-xs">
                  {t('dashboard.currentModel')}
                </Text>
                <p className="font-semibold text-base">{displayStatus.model}</p>
              </div>
            </div>
            {displayStatus?.token_usage && ((displayStatus?.token_usage?.total_tokens ?? 0) + (displayStatus?.token_usage?.prompt_tokens ?? 0) + (displayStatus?.token_usage?.completion_tokens ?? 0)) > 0 && (
              <div className="flex flex-col gap-2 text-sm">
                <div className="flex items-center gap-4">
                  <div>
                    <Text type="secondary" className="text-xs block">{t('dashboard.tokenUsageToday')}</Text>
                    <span className="font-medium">
                      {formatTokenCount(displayStatus?.token_usage?.total_tokens ?? 0)}
                    </span>
                    <Text type="secondary" className="text-xs ml-1">{t('common.total')}</Text>
                  </div>
                  <div>
                    <Text type="secondary" className="text-xs block">{t('dashboard.chartPrompt')}</Text>
                    <span className="font-medium">
                      {formatTokenCount(displayStatus?.token_usage?.prompt_tokens ?? 0)}
                    </span>
                  </div>
                  <div>
                    <Text type="secondary" className="text-xs block">{t('dashboard.chartCompletion')}</Text>
                    <span className="font-medium">
                      {formatTokenCount(displayStatus?.token_usage?.completion_tokens ?? 0)}
                    </span>
                  </div>
                </div>
                {displayStatus?.token_usage?.by_model && Object.keys(displayStatus.token_usage.by_model).length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(displayStatus.token_usage.by_model).map(([model, u]) => (
                      <Tag key={model} className="m-0">
                        {model}: {formatTokenCount(u.total_tokens ?? 0)}
                        {displayStatus?.token_usage?.cost_by_model?.[model] != null &&
                          displayStatus.token_usage.cost_by_model[model] > 0 && (
                            <span className="ml-1 text-green-600 dark:text-green-400">
                              ({formatCost(displayStatus.token_usage.cost_by_model[model])})
                            </span>
                          )}
                      </Tag>
                    ))}
                  </div>
                )}
              </div>
            )}
            {/* 每日 Token 用量趋势图 */}
            {usageHistory && usageHistory.length > 0 && (
              <div className="w-full min-w-[320px]" style={{ maxWidth: 480 }}>
                <Text type="secondary" className="text-xs block mb-1">{t('dashboard.dailyTokenUsage')}</Text>
                <div style={{ height: 44 }}>
                  <Tiny.Area
                    data={usageHistory.map((d) => ({
                      date: d.date.slice(5),
                      value: d.total_tokens ?? 0,
                    }))}
                    xField="date"
                    yField="value"
                    smooth
                    color="#3b82f6"
                    areaStyle={{ fill: 'l(90) 0:rgba(59,130,246,0.35) 1:rgba(59,130,246,0.05)' }}
                  />
                </div>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* 每日 Token 使用量 + 按模型成本分布：占满主内容区剩余高度 */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 auto-rows-fr lg:grid-cols-2 lg:grid-rows-1">
        <Card
          title={
            <span className="flex items-center gap-2">
              <BarChartOutlined className="text-amber-500" /> {t('dashboard.dailyTokenUsage')}
            </span>
          }
          size="small"
          className="flex min-h-0 min-w-0 flex-col [&_.ant-card-head]:shrink-0 [&_.ant-card-body]:flex [&_.ant-card-body]:min-h-0 [&_.ant-card-body]:flex-1 [&_.ant-card-body]:flex-col"
        >
          {usageLoading ? (
            <div className="flex min-h-[240px] flex-1 items-center justify-center">
              <Spin />
            </div>
          ) : usageHistory && usageHistory.length > 0 ? (
            <div className="flex min-h-0 w-full flex-1 flex-col" style={{ minHeight: 240 }}>
              <Column
                data={toColumnData(usageHistory, t)}
                xField="date"
                yField="value"
                seriesField="type"
                group
                paddingBottom={56}
                scale={{
                  x: { padding: 0.5 },
                }}
                style={{
                  fill: (d: { type: string }) =>
                    d.type === t('dashboard.chartPrompt')
                      ? '#3b82f6'
                      : d.type === t('dashboard.chartCompletion')
                        ? '#22c55e'
                        : '#94a3b8',
                }}
                label={{
                  text: 'value',
                  position: 'top',
                  style: { dy: -16 },
                  formatter: (v: unknown) => {
                    const n = Number(v);
                    return n > 0 ? formatTokenCount(n) : '';
                  },
                }}
                axis={{
                  x: {
                    label: {
                      formatter: (v: string) => (typeof v === 'string' ? v.slice(5) : String(v)),
                    },
                    labelTextAlign: 'center',
                    labelTextBaseline: 'middle',
                    labelTransform: 'rotate(-30deg)',
                    labelSpacing: 12,
                  },
                  y: {
                    label: {
                      formatter: (v: string) => formatTokenCount(Number(v)),
                    },
                  },
                }}
                legend={{ position: 'top' }}
              />
            </div>
          ) : (
            <div className="flex min-h-[200px] flex-1 flex-col items-center justify-center py-8">
              <Text type="secondary" className="text-center">
                {t('dashboard.noUsageData')}
              </Text>
            </div>
          )}
        </Card>

        <Card
          title={
            <span className="flex items-center gap-2">
              <ThunderboltOutlined className="text-amber-500" /> {t('dashboard.modelShareTitle')}
            </span>
          }
          size="small"
          className="flex min-h-0 min-w-0 flex-col [&_.ant-card-head]:shrink-0 [&_.ant-card-body]:flex [&_.ant-card-body]:min-h-0 [&_.ant-card-body]:flex-1 [&_.ant-card-body]:flex-col"
        >
          <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-4">
            <div className="flex shrink-0 items-center justify-center" style={{ width: 180, height: 180 }}>
              <Pie
                data={Object.entries(displayStatus?.token_usage?.by_model ?? {})
                  .filter(([, v]) => (v.total_tokens ?? 0) > 0)
                  .map(([model, u]) => ({ type: model, value: u.total_tokens ?? 0 }))}
                angleField="value"
                colorField="type"
                radius={0.8}
                innerRadius={0.4}
                label={false}
                legend={false}
                tooltip={{
                  items: [
                    {
                      channel: 'y',
                      valueFormatter: (v: number) => formatTokenCount(v),
                    },
                  ],
                }}
              />
            </div>
            <div className="flex flex-col gap-2">
              {Object.entries(displayStatus?.token_usage?.by_model ?? {})
                .filter(([, v]) => (v.total_tokens ?? 0) > 0)
                .map(([model, u]) => (
                  <div key={model} className="flex items-center justify-between gap-4">
                    <span className="font-medium truncate max-w-[100px]">{model}</span>
                    <span className="text-amber-600 dark:text-amber-400 font-mono">
                      {formatTokenCount(u.total_tokens ?? 0)}
                    </span>
                  </div>
                ))}
              {(!(displayStatus?.token_usage?.by_model) ||
                Object.entries(displayStatus?.token_usage?.by_model ?? {}).filter(([, u]) => (u.total_tokens ?? 0) > 0).length === 0) && (
                <Text type="secondary" className="text-xs">{t('dashboard.noData')}</Text>
              )}
            </div>
          </div>
        </Card>
      </div>

    </div>
  );
}
