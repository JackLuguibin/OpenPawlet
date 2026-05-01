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
  PieChartOutlined,
} from '@ant-design/icons';
import {
  DailyTokenSparklineChart,
  DailyTokenStackedBarChart,
  ModelSharePieChart,
} from '../components/DashboardCharts';
import { formatTokenCount, formatCost } from '../utils/format';
import { PageLayout } from '../components/PageLayout';
import {
  ConsolePageShell,
  ConsolePageHeading,
  ConsolePageTitleBlock,
} from '../components/ConsolePageChrome';
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

/** Pie / bar chart layout: when the charts area (not window) is this narrow, use compact + scrollable charts. */
const CHARTS_AREA_NARROW_PX = 640;

/** Matching Ant Card chrome for the Dashboard chart pair (same head + flex body). */
const DASHBOARD_CHART_PAIR_CARD_CLASS =
  'flex h-full min-h-0 min-w-0 flex-col overflow-hidden [&_.ant-card-head]:shrink-0 [&_.ant-card-body]:flex [&_.ant-card-body]:min-h-0 [&_.ant-card-body]:flex-1 [&_.ant-card-body]:flex-col [&_.ant-card-body]:overflow-visible';

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
    <ConsolePageShell innerClassName="gap-6">
      <ConsolePageHeading
        surface="hero"
        className="shrink-0"
        rowGapClass="gap-4"
        rowAlign="center"
        heading={
          <ConsolePageTitleBlock title={t('dashboard.title')} subtitle={t('dashboard.subtitle')} />
        }
        extra={
          <Space className="w-full sm:w-auto justify-end flex-wrap">
            {displayStatus?.running && (
              <Button
                danger
                icon={<PoweroffOutlined />}
                loading={stopMutation.isPending}
                aria-label={t('dashboard.stop')}
                onClick={() => stopMutation.mutate()}
              >
                <span className="hidden sm:inline">{t('dashboard.stop')}</span>
              </Button>
            )}
            <Button
              icon={<SyncOutlined />}
              loading={restartMutation.isPending}
              aria-label={t('dashboard.restart')}
              onClick={handleRestart}
            >
              <span className="hidden sm:inline">{t('dashboard.restart')}</span>
            </Button>
            <Button
              icon={<ReloadOutlined />}
              aria-label={t('common.refresh')}
              onClick={() => {
                refetch();
                queryClient.invalidateQueries({ queryKey: ['usage-history', currentBotId] });
              }}
            />
          </Space>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-x-hidden overflow-y-auto overscroll-y-contain pb-safe">
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
                <div className="h-11 w-full min-w-0 max-w-full overflow-visible sm:max-w-[280px]">
                  <DailyTokenSparklineChart
                    isDarkUi={isDarkUi}
                    history={usageHistory}
                    style={{ width: '100%', height: '100%' }}
                  />
                </div>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* 每日 Token + 模型占比（宽度用于饼图图例自适应；纵向滚动由外层统一容器承担） */}
      <div ref={chartsAreaRef} className="min-h-0 w-full min-w-0">
      <div className="grid min-h-0 w-full min-w-0 grid-cols-1 gap-4 auto-rows-[minmax(300px,auto)] lg:min-h-full lg:grid-cols-2 lg:grid-rows-1 lg:auto-rows-[minmax(280px,1fr)]">
        <Card
          title={
            <span className="flex items-center gap-2">
              <BarChartOutlined className="text-amber-500" /> {t('dashboard.dailyTokenUsage')}
            </span>
          }
          size="small"
          className={DASHBOARD_CHART_PAIR_CARD_CLASS}
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
              <div className="flex min-h-[240px] w-full min-w-0 flex-1 flex-col overflow-visible pb-1 sm:min-h-[260px] lg:min-h-[280px]">
                <DailyTokenStackedBarChart
                  chartLayoutNarrow={chartLayoutNarrow}
                  isDarkUi={isDarkUi}
                  history={usageHistory}
                  promptLabel={t('dashboard.chartPrompt')}
                  completionLabel={t('dashboard.chartCompletion')}
                  style={{ width: '100%', height: '100%', minHeight: 236 }}
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
          title={
            <span className="flex items-center gap-2">
              <PieChartOutlined className="text-amber-500" /> {t('dashboard.modelShareTitle')}
            </span>
          }
          size="small"
          className={DASHBOARD_CHART_PAIR_CARD_CLASS}
        >
          {modelPieRows.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center py-8">
              <Text type="secondary" className="text-center">
                {t('dashboard.noUsageData')}
              </Text>
            </div>
          ) : (
            <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
              <Text type="secondary" className="text-xs shrink-0 mb-1 tabular-nums">
                {formatTokenCount(modelPieTotal)}
              </Text>
              <div className="flex min-h-[240px] w-full min-w-0 flex-1 flex-col overflow-visible pb-1 sm:min-h-[260px] lg:min-h-[280px]">
                <ModelSharePieChart
                  chartLayoutNarrow={chartLayoutNarrow}
                  isDarkUi={isDarkUi}
                  modelPieRows={modelPieRows}
                  modelPieTotal={modelPieTotal}
                  colors={modelPieColorRange}
                  emptyFill={modelPieEmptyFill}
                  seriesNameAllTime={t('dashboard.modelUsageAllTime')}
                  style={{ width: '100%', height: '100%', minHeight: 236 }}
                />
              </div>
            </div>
          )}
        </Card>
      </div>
      </div>
      </div>

    </ConsolePageShell>
  );
}
