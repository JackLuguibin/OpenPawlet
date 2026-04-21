import { useEffect, useMemo, useRef } from 'react';
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
import { Column, Tiny } from '@ant-design/plots';
import { ModelPieChart, type EChartsOption } from '../components/ModelPieChart';
import type { UsageHistoryItem } from '../api/types';
import { formatTokenCount, formatCost } from '../utils/format';
import { PageLayout } from '../components/PageLayout';
import { useBots } from '../hooks/useBots';
import { formatQueryError } from '../utils/errors';

const { Text } = Typography;

/** Categorical colors for model share pie (light UI) */
const MODEL_PIE_PALETTE_LIGHT = [
  '#d97706',
  '#2563eb',
  '#059669',
  '#7c3aed',
  '#db2777',
  '#0d9488',
  '#ea580c',
  '#4f46e5',
];

/** Categorical colors for model share pie (dark UI) */
const MODEL_PIE_PALETTE_DARK = [
  '#fbbf24',
  '#60a5fa',
  '#34d399',
  '#a78bfa',
  '#f472b6',
  '#2dd4bf',
  '#fb923c',
  '#818cf8',
];

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
  const { setStatus, setChannels, setMCPServers, status, addToast, currentBotId, theme } =
    useAppStore();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['status', currentBotId],
    queryFn: () => api.getStatus(currentBotId),
    refetchInterval: false,
  });

  const { data: bots = [] } = useBots();

  const { data: usageHistory, isLoading: usageLoading } = useQuery({
    queryKey: ['usage-history', currentBotId],
    queryFn: () => api.getUsageHistory(currentBotId, 14),
    refetchInterval: false,
  });

  // 用当前 bot 的 API 数据作为展示源，避免与 store 中其他 bot 或旧数据混用
  const displayStatus = data ?? status;

  const modelPieRows = useMemo(() => {
    const rows = Object.entries(displayStatus?.token_usage?.by_model ?? {})
      .filter(([, v]) => (v.total_tokens ?? 0) > 0)
      .map(([model, u]) => ({ type: model, value: u.total_tokens ?? 0 }));
    rows.sort((a, b) => b.value - a.value);
    return rows;
  }, [displayStatus]);

  const modelPieTotal = useMemo(
    () => modelPieRows.reduce((sum, r) => sum + r.value, 0),
    [modelPieRows],
  );

  const isDarkUi = useMemo(() => {
    return (
      theme === 'dark' ||
      (theme === 'system' &&
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches)
    );
  }, [theme]);

  const modelPieEmptyFill = useMemo(() => (isDarkUi ? '#4b5563' : '#e2e8f0'), [isDarkUi]);

  const modelPieColorRange = useMemo(() => {
    const n = modelPieRows.length;
    if (n === 0) return [];
    const base = isDarkUi ? MODEL_PIE_PALETTE_DARK : MODEL_PIE_PALETTE_LIGHT;
    return Array.from({ length: n }, (_, i) => base[i % base.length]);
  }, [modelPieRows.length, isDarkUi]);

  const modelPieChartOption = useMemo((): EChartsOption => {
    const titleTextColor = isDarkUi ? '#f3f4f6' : '#111827';
    const subtextColor = isDarkUi ? '#9ca3af' : '#6b7280';
    const legendTextColor = isDarkUi ? '#d1d5db' : '#4b5563';
    const tooltipTextColor = isDarkUi ? '#e5e7eb' : '#1f2937';
    const tooltipBg = isDarkUi ? 'rgba(17, 24, 39, 0.92)' : 'rgba(255, 255, 255, 0.96)';

    const empty = modelPieRows.length === 0;
    if (empty) {
      return {
        backgroundColor: 'transparent',
        title: {
          text: t('dashboard.modelShareTitle'),
          subtext: t('dashboard.noUsageData'),
          left: 'center',
          textStyle: { color: titleTextColor, fontSize: 16, fontWeight: 600 },
          subtextStyle: { color: subtextColor },
        },
        tooltip: { show: false },
        legend: { show: false },
        series: [
          {
            type: 'pie',
            radius: '50%',
            center: ['50%', '55%'],
            silent: true,
            animation: false,
            label: { show: false },
            labelLine: { show: false },
            data: [
              {
                value: 1,
                name: '',
                itemStyle: { color: modelPieEmptyFill },
              },
            ],
          },
        ],
      };
    }

    return {
      backgroundColor: 'transparent',
      title: {
        text: t('dashboard.modelShareTitle'),
        subtext: formatTokenCount(modelPieTotal),
        left: 'center',
        textStyle: { color: titleTextColor, fontSize: 16, fontWeight: 600 },
        subtextStyle: { color: subtextColor },
      },
      tooltip: {
        trigger: 'item',
        backgroundColor: tooltipBg,
        borderColor: isDarkUi ? '#374151' : '#e5e7eb',
        textStyle: { color: tooltipTextColor },
        formatter: (params) => {
          if (!params || typeof params !== 'object' || !('name' in params)) return '';
          const p = params as { name: string; value: number; percent: number };
          return `${p.name}<br/><span style="font-variant-numeric: tabular-nums">${formatTokenCount(p.value)} (${p.percent.toFixed(1)}%)</span>`;
        },
      },
      legend: {
        orient: 'vertical',
        left: 'left',
        textStyle: { color: legendTextColor },
        type: 'scroll',
      },
      color: modelPieColorRange,
      series: [
        {
          name: t('dashboard.tokenUsageToday'),
          type: 'pie',
          radius: '50%',
          center: ['50%', '55%'],
          data: modelPieRows.map((r) => ({ name: r.type, value: r.value })),
          emphasis: {
            itemStyle: {
              shadowBlur: 10,
              shadowOffsetX: 0,
              shadowColor: 'rgba(0, 0, 0, 0.5)',
            },
          },
        },
      ],
    };
  }, [
    modelPieRows,
    modelPieColorRange,
    modelPieEmptyFill,
    modelPieTotal,
    isDarkUi,
    t,
  ]);

  const columnChartWrapRef = useRef<HTMLDivElement>(null);
  /** Plot 实例（类型声明成 Chart）：autoFit 只监听 window.resize，容器尺寸变化需 triggerResize */
  const columnPlotRef = useRef<{ triggerResize: () => void } | null>(null);

  useEffect(() => {
    const el = columnChartWrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try {
          columnPlotRef.current?.triggerResize();
        } catch {
          columnPlotRef.current = null;
        }
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [usageLoading, usageHistory]);

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
      addToast({ type: 'error', message: formatQueryError(error) });
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
      addToast({ type: 'error', message: formatQueryError(error) });
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
          message={t('dashboard.loadError')}
          description={formatQueryError(error)}
          showIcon
        />
      </PageLayout>
    );
  }

  return (
    <PageLayout>
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
            <div className="flex flex-1 items-center justify-center py-12">
              <Spin />
            </div>
          ) : usageHistory && usageHistory.length > 0 ? (
            <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
              <div
                ref={columnChartWrapRef}
                className="flex min-h-0 w-full flex-1 flex-col [&_.antv-chart]:min-h-0"
              >
                <Column
                  className="flex min-h-0 flex-1 flex-col [&>div]:min-h-0 [&>div]:flex-1"
                  containerStyle={{ width: '100%', height: '100%', flex: 1, minHeight: 0 }}
                  data={toColumnData(usageHistory, t)}
                  xField="date"
                  yField="value"
                  seriesField="type"
                  group
                  autoFit
                  onReady={(chart) => {
                    const plot = chart as unknown as { triggerResize: () => void };
                    columnPlotRef.current = plot;
                    plot.triggerResize();
                  }}
                  marginLeft={52}
                marginRight={8}
                marginBottom={28}
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
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center py-8">
              <Text type="secondary" className="text-center">
                {t('dashboard.noUsageData')}
              </Text>
            </div>
          )}
        </Card>

        <Card
          size="small"
          className="flex min-h-0 min-w-0 flex-col [&_.ant-card-head]:shrink-0 [&_.ant-card-body]:flex [&_.ant-card-body]:min-h-0 [&_.ant-card-body]:flex-1 [&_.ant-card-body]:flex-col"
        >
          <div className="flex min-h-[360px] w-full flex-1 flex-col">
            <ModelPieChart option={modelPieChartOption} style={{ height: '100%', width: '100%', minHeight: 360 }} />
          </div>
        </Card>
      </div>

    </PageLayout>
  );
}
