import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store';
import * as api from '../api/client';
import {
  Card,
  Statistic,
  Button,
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
import { EChartsWithResize, ModelPieChart, type EChartsOption } from '../components/ModelPieChart';
import { formatTokenCount, formatCost } from '../utils/format';
import { PageLayout } from '../components/PageLayout';
import { PAGE_PRIMARY_TITLE_CLASS } from '../utils/pageTitleClasses';
import { useBots } from '../hooks/useBots';
import { useAgentTimeZone } from '../hooks/useAgentTimeZone';
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

/** Stat cards: responsive grid + Ant Statistic layout (spacing, alignment, KPI typography) */
const DASHBOARD_STAT_GRID_CLASS =
  'grid shrink-0 grid-cols-2 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2 sm:gap-3 min-w-0 ' +
  '[&_.ant-statistic-title]:mb-0 [&_.ant-statistic-title]:min-h-[14px] [&_.ant-statistic-title]:text-center ' +
  '[&_.ant-statistic-title]:text-[10px] [&_.ant-statistic-title]:leading-tight ' +
  '[&_.ant-statistic-content-prefix]:inline-flex [&_.ant-statistic-content-prefix]:items-center [&_.ant-statistic-content-prefix]:me-0 ' +
  '[&_.ant-statistic-content_.ant-badge-status]:align-middle [&_.ant-statistic-content_.ant-badge-status-dot]:!top-0 ' +
  '[&_.ant-statistic-content]:mt-0.5 [&_.ant-statistic-content]:min-h-[28px] [&_.ant-statistic-content]:flex [&_.ant-statistic-content]:items-center ' +
  '[&_.ant-statistic-content]:justify-center [&_.ant-statistic-content]:gap-1.5 ' +
  '[&_.ant-statistic-content-value]:text-xs [&_.ant-statistic-content-value]:sm:text-sm [&_.ant-statistic-content-value]:xl:text-base ' +
  '[&_.ant-statistic-content-value]:font-semibold [&_.ant-statistic-content-value]:tabular-nums ' +
  '[&_.ant-statistic-skeleton]:pt-0';

const DASHBOARD_STAT_CARD_CLASS =
  'h-full min-w-0 [&_.ant-card-body]:flex [&_.ant-card-body]:flex-col [&_.ant-card-body]:h-full ' +
  '[&_.ant-card-body]:min-w-0 [&_.ant-card-body]:py-2';

/** Pie legend layout: when the charts area (not window) is this narrow, use horizontal legend. */
const CHARTS_AREA_NARROW_PX = 520;

function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export default function Dashboard() {
  const { t } = useTranslation();
  const agentTz = useAgentTimeZone();
  const chartsAreaRef = useRef<HTMLDivElement>(null);
  const [chartLayoutNarrow, setChartLayoutNarrow] = useState(false);
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

  const modelPieByModel = useMemo(
    () => displayStatus?.model_token_totals ?? displayStatus?.token_usage?.by_model,
    [displayStatus?.model_token_totals, displayStatus?.token_usage?.by_model],
  );

  const modelPieRows = useMemo(() => {
    const rows = Object.entries(modelPieByModel ?? {})
      .filter(([, v]) => (v.total_tokens ?? 0) > 0)
      .map(([model, u]) => ({ type: model, value: u.total_tokens ?? 0 }));
    rows.sort((a, b) => b.value - a.value);
    return rows;
  }, [modelPieByModel]);

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
      legend: chartLayoutNarrow
        ? {
            orient: 'horizontal',
            bottom: 0,
            left: 'center',
            textStyle: { color: legendTextColor },
            type: 'scroll',
          }
        : {
            orient: 'vertical',
            left: 'left',
            textStyle: { color: legendTextColor },
            type: 'scroll',
          },
      color: modelPieColorRange,
      series: [
        {
          name: t('dashboard.modelUsageAllTime'),
          type: 'pie',
          radius: chartLayoutNarrow ? '48%' : '50%',
          center: chartLayoutNarrow ? ['50%', '44%'] : ['50%', '55%'],
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
    chartLayoutNarrow,
    t,
  ]);

  /** Daily token: vertical stacked bars (same stack/tooltip style as horizontal example, rotated 90°) */
  const dailyTokenStackBarOption = useMemo((): EChartsOption => {
    const history = usageHistory ?? [];
    if (history.length === 0) {
      return { series: [] };
    }

    const axisLabelColor = isDarkUi ? '#9ca3af' : '#6b7280';
    const totalLabelColor = isDarkUi ? '#e5e7eb' : '#374151';
    const legendTextColor = isDarkUi ? '#d1d5db' : '#4b5563';
    const tooltipTextColor = isDarkUi ? '#e5e7eb' : '#1f2937';
    const tooltipBg = isDarkUi ? 'rgba(17, 24, 39, 0.92)' : 'rgba(255, 255, 255, 0.96)';
    const splitLineColor = isDarkUi ? '#374151' : '#e5e7eb';

    const xCategories = history.map((d) => d.date.slice(5));
    const promptLabel = t('dashboard.chartPrompt');
    const completionLabel = t('dashboard.chartCompletion');
    const promptData = history.map((d) => d.prompt_tokens ?? 0);
    const completionData = history.map((d) => d.completion_tokens ?? 0);

    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        backgroundColor: tooltipBg,
        borderColor: isDarkUi ? '#374151' : '#e5e7eb',
        textStyle: { color: tooltipTextColor },
        formatter: (params: unknown) => {
          if (!Array.isArray(params) || params.length === 0) return '';
          const rows = params as Array<{
            axisValue?: string;
            seriesName?: string;
            value?: number | string;
            marker?: string;
          }>;
          const axis = rows[0].axisValue ?? '';
          const lines = rows.map(
            (p) =>
              `${p.marker ?? ''} ${p.seriesName ?? ''}: ${formatTokenCount(Number(p.value ?? 0))}`,
          );
          return [axis, ...lines].join('<br/>');
        },
      },
      legend: {
        bottom: 0,
        left: 'center',
        textStyle: { color: legendTextColor },
      },
      grid: {
        left: 8,
        right: 8,
        top: 8,
        bottom: chartLayoutNarrow ? 52 : 40,
        containLabel: true,
      },
      xAxis: {
        type: 'category',
        data: xCategories,
        axisLabel: {
          color: axisLabelColor,
          rotate: 40,
          interval: 0,
          margin: 12,
        },
        axisTick: { alignWithLabel: true },
      },
      yAxis: {
        type: 'value',
        axisLabel: {
          color: axisLabelColor,
          formatter: (v: string | number) => formatTokenCount(Number(v)),
        },
        splitLine: { lineStyle: { color: splitLineColor, type: 'dashed' } },
      },
      series: [
        {
          name: promptLabel,
          type: 'bar',
          stack: 'total',
          barMaxWidth: 44,
          barCategoryGap: '12%',
          itemStyle: { color: '#3b82f6' },
          emphasis: { focus: 'series' },
          label: { show: false },
          data: promptData,
        },
        {
          name: completionLabel,
          type: 'bar',
          stack: 'total',
          barMaxWidth: 44,
          barCategoryGap: '12%',
          itemStyle: { color: '#22c55e' },
          emphasis: { focus: 'series' },
          label: {
            show: true,
            position: 'top',
            distance: 6,
            color: totalLabelColor,
            fontSize: 11,
            fontWeight: 600,
            formatter: (p: unknown) => {
              const idx =
                typeof p === 'object' && p !== null && 'dataIndex' in p
                  ? Number((p as { dataIndex: unknown }).dataIndex)
                  : 0;
              const total = (promptData[idx] ?? 0) + (completionData[idx] ?? 0);
              return total > 0 ? formatTokenCount(total) : '';
            },
          },
          data: completionData,
        },
      ],
    };
  }, [usageHistory, t, isDarkUi, chartLayoutNarrow]);

  /** Compact sparkline for model card: daily total tokens (ECharts, matches main charts) */
  const dailyTokenSparklineOption = useMemo((): EChartsOption => {
    const history = usageHistory ?? [];
    if (history.length === 0) {
      return { series: [] };
    }
    const dates = history.map((d) => d.date.slice(5));
    const values = history.map((d) => d.total_tokens ?? 0);
    const tooltipBg = isDarkUi ? 'rgba(17, 24, 39, 0.92)' : 'rgba(255, 255, 255, 0.96)';
    const tooltipTextColor = isDarkUi ? '#e5e7eb' : '#1f2937';

    return {
      backgroundColor: 'transparent',
      grid: { left: 0, right: 0, top: 2, bottom: 0, containLabel: false },
      xAxis: {
        type: 'category',
        data: dates,
        boundaryGap: false,
        show: false,
      },
      yAxis: {
        type: 'value',
        show: false,
        scale: true,
      },
      tooltip: {
        trigger: 'axis',
        // Sparkline sits in overflow-hidden cards; render tooltip on body so it is not clipped.
        appendToBody: true,
        axisPointer: { type: 'line', lineStyle: { color: '#3b82f6', width: 1 } },
        backgroundColor: tooltipBg,
        borderColor: isDarkUi ? '#374151' : '#e5e7eb',
        textStyle: { color: tooltipTextColor, fontSize: 12 },
        formatter: (params: unknown) => {
          if (!Array.isArray(params) || params.length === 0) return '';
          const p = params[0] as { axisValue?: string; value?: number };
          const v = Number(p.value ?? 0);
          return `${p.axisValue ?? ''}<br/>${formatTokenCount(v)}`;
        },
      },
      series: [
        {
          type: 'line',
          smooth: true,
          symbol: 'none',
          sampling: 'lttb',
          lineStyle: { width: 1.5, color: '#3b82f6' },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(59, 130, 246, 0.35)' },
                { offset: 1, color: 'rgba(59, 130, 246, 0.05)' },
              ],
            },
          },
          data: values,
        },
      ],
    };
  }, [usageHistory, isDarkUi]);

  useEffect(() => {
    if (data) {
      setStatus(data);
      setChannels(data.channels || []);
      setMCPServers(data.mcp_servers || []);
    }
  }, [data, setStatus, setChannels, setMCPServers]);

  // Match pie legend to the actual charts row width (sidebar / split panes can be narrower than the window).
  useLayoutEffect(() => {
    const el = chartsAreaRef.current;
    if (!el) return;
    const apply = (width: number) => {
      setChartLayoutNarrow(width < CHARTS_AREA_NARROW_PX);
    };
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w != null && Number.isFinite(w)) apply(w);
    });
    ro.observe(el);
    apply(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

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
          title={t('dashboard.loadError')}
          description={formatQueryError(error)}
          showIcon
        />
      </PageLayout>
    );
  }

  return (
    <PageLayout className="min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden">
      <div className="flex min-h-0 shrink flex-col gap-6 overflow-y-auto">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between">
        <div>
          <h1 className={PAGE_PRIMARY_TITLE_CLASS}>
            {t('dashboard.title')}
          </h1>
          <p className="mt-1 text-[13px] leading-relaxed text-gray-500 dark:text-gray-400">
            {t('dashboard.subtitle')}
          </p>
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

      <div className={DASHBOARD_STAT_GRID_CLASS}>
        <Card size="small" className={DASHBOARD_STAT_CARD_CLASS}>
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
        <Card size="small" className={DASHBOARD_STAT_CARD_CLASS}>
          <Statistic
            title={t('dashboard.statUptime')}
            value={displayStatus?.running && displayStatus?.uptime_seconds ? formatUptime(displayStatus.uptime_seconds) : '-'}
            prefix={<ClockCircleOutlined className="text-gray-400" />}
          />
        </Card>
        <Card size="small" className={DASHBOARD_STAT_CARD_CLASS}>
          <Statistic
            title={t('dashboard.statActiveSessions')}
            value={displayStatus?.active_sessions ?? 0}
            prefix={<TeamOutlined className="text-gray-400" />}
          />
        </Card>
        <Card size="small" className={DASHBOARD_STAT_CARD_CLASS}>
          <Statistic
            title={t('dashboard.statMessagesToday')}
            value={displayStatus?.messages_today ?? 0}
            prefix={<MessageOutlined className="text-gray-400" />}
          />
        </Card>
        <Card size="small" className={DASHBOARD_STAT_CARD_CLASS}>
          <Statistic
            title={t('dashboard.statTokensToday')}
            value={
              displayStatus?.token_usage?.total_tokens != null
                ? formatTokenCount(displayStatus.token_usage.total_tokens)
                : '-'
            }
            prefix={<ThunderboltOutlined className="text-gray-400" />}
          />
        </Card>
        <Card size="small" className={DASHBOARD_STAT_CARD_CLASS}>
          <Statistic
            title={t('dashboard.statCostToday')}
            value={
              displayStatus?.token_usage?.cost_usd != null && displayStatus.token_usage.cost_usd > 0
                ? formatCost(displayStatus.token_usage.cost_usd)
                : '-'
            }
            prefix={<DollarOutlined className="text-gray-400" />}
          />
        </Card>
      </div>

      {/* Model Info & Token Usage */}
      {displayStatus?.model && (
        <Card size="small" className="shrink-0 min-w-0 overflow-hidden">
          {/* One wrapping row: model | stats | sparkline; sparkline drops to its own full-width row only on very narrow screens */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-4">
            <div className="flex min-w-0 shrink-0 items-center gap-3">
              <div className="shrink-0 flex h-9 w-9 items-center justify-center rounded border border-gray-200 dark:border-gray-700">
                <ThunderboltOutlined className="text-base text-gray-500 dark:text-gray-400" />
              </div>
              <div className="min-w-0">
                <Text type="secondary" className="text-xs">
                  {t('dashboard.currentModel')}
                </Text>
                <p className="break-words text-[15px] font-semibold tracking-tight">
                  {displayStatus.model}
                </p>
              </div>
            </div>
            {displayStatus?.token_usage &&
              ((displayStatus.token_usage.total_tokens ?? 0) > 0 ||
                (displayStatus.token_usage.prompt_tokens ?? 0) > 0 ||
                (displayStatus.token_usage.completion_tokens ?? 0) > 0) && (
              <div className="flex min-w-0 flex-1 basis-[min(100%,14rem)] flex-col gap-2 text-sm min-[600px]:max-w-xl min-[600px]:items-end min-[600px]:text-right">
                <div className="grid w-full grid-cols-1 gap-3 min-[380px]:grid-cols-3 sm:gap-4 min-[600px]:w-auto min-[600px]:justify-items-end">
                  <div className="min-w-0">
                    <Text type="secondary" className="block text-xs">
                      {t('dashboard.tokenUsageToday')}
                    </Text>
                    <span className="font-medium">
                      {formatTokenCount(displayStatus.token_usage.total_tokens ?? 0)}
                    </span>
                    <Text type="secondary" className="ml-1 text-xs">
                      {t('common.total')}
                    </Text>
                  </div>
                  <div className="min-w-0">
                    <Text type="secondary" className="block text-xs">
                      {t('dashboard.chartPrompt')}
                    </Text>
                    <span className="font-medium">
                      {formatTokenCount(displayStatus.token_usage.prompt_tokens ?? 0)}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <Text type="secondary" className="block text-xs">
                      {t('dashboard.chartCompletion')}
                    </Text>
                    <span className="font-medium">
                      {formatTokenCount(displayStatus.token_usage.completion_tokens ?? 0)}
                    </span>
                  </div>
                </div>
              </div>
            )}
            {usageHistory && usageHistory.length > 0 && (
              <div className="flex min-w-full max-w-full basis-full flex-col max-sm:items-end sm:min-w-0 sm:max-w-none sm:basis-auto sm:ml-auto sm:w-[min(100%,280px)] sm:shrink-0 sm:items-end sm:text-right">
                <Text type="secondary" className="mb-1 block text-xs">
                  {t('dashboard.dailyTokenUsage')}
                </Text>
                <div className="h-11 w-full min-w-0 max-w-full overflow-hidden sm:max-w-[280px]">
                  <EChartsWithResize
                    style={{ width: '100%', height: '100%' }}
                    option={dailyTokenSparklineOption}
                  />
                </div>
              </div>
            )}
          </div>
        </Card>
      )}
      </div>

      {/* 每日 Token + 模型占比：在锁定主滚动后由 flex-1 占满视口；区域过高时在内部滚动，避免饼图行被父级 overflow 裁切 */}
      <div
        ref={chartsAreaRef}
        className="min-h-0 w-full min-w-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
      <div className="grid min-h-0 w-full min-w-0 grid-cols-1 gap-4 auto-rows-[minmax(280px,auto)] lg:min-h-full lg:grid-cols-2 lg:grid-rows-1 lg:auto-rows-[minmax(280px,1fr)]">
        <Card
          title={
            <span className="flex items-center gap-2">
              <BarChartOutlined className="text-amber-500" /> {t('dashboard.dailyTokenUsage')}
            </span>
          }
          size="small"
          className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden [&_.ant-card-head]:shrink-0 [&_.ant-card-body]:flex [&_.ant-card-body]:min-h-0 [&_.ant-card-body]:flex-1 [&_.ant-card-body]:flex-col [&_.ant-card-body]:overflow-visible"
        >
          {usageLoading ? (
            <div className="flex flex-1 items-center justify-center py-12">
              <Spin />
            </div>
          ) : usageHistory && usageHistory.length > 0 ? (
            <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
              <Text type="secondary" className="text-xs shrink-0 mb-1">
                {t('dashboard.usageDailyByCalendar', { tz: agentTz })}
              </Text>
              <div className="min-h-[260px] w-full min-w-0 flex-1 overflow-visible pb-1 lg:min-h-[280px]">
                <EChartsWithResize
                  style={{ width: '100%', height: '100%', minHeight: 260 }}
                  option={dailyTokenStackBarOption}
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
          className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden [&_.ant-card-head]:shrink-0 [&_.ant-card-body]:flex [&_.ant-card-body]:min-h-0 [&_.ant-card-body]:flex-1 [&_.ant-card-body]:flex-col [&_.ant-card-body]:overflow-x-hidden [&_.ant-card-body]:overflow-y-hidden"
        >
          <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
            <ModelPieChart
              option={modelPieChartOption}
              style={{ height: '100%', width: '100%' }}
            />
          </div>
        </Card>
      </div>
      </div>
      </div>

    </PageLayout>
  );
}
