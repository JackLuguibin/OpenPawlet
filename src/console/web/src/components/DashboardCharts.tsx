import { useMemo, type CSSProperties } from 'react';
import '../charts/register';
import { Chart as ChartJsComponent, Doughnut, Bar } from 'react-chartjs-2';
import type { Chart as ChartType, Plugin, ChartOptions } from 'chart.js';
import { formatTokenCount } from '../utils/format';

type UsageDay = {
  date: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type ModelSharePieProps = {
  chartLayoutNarrow: boolean;
  isDarkUi: boolean;
  modelPieRows: { type: string; value: number }[];
  modelPieTotal: number;
  colors: string[];
  emptyFill: string;
  seriesNameAllTime: string;
  className?: string;
  style?: CSSProperties;
};

export function ModelSharePieChart({
  chartLayoutNarrow,
  isDarkUi,
  modelPieRows,
  modelPieTotal,
  colors,
  emptyFill,
  seriesNameAllTime,
  className,
  style,
}: ModelSharePieProps) {
  const legendTextColor = isDarkUi ? '#d1d5db' : '#4b5563';
  const tooltipBg = isDarkUi ? 'rgba(17, 24, 39, 0.92)' : 'rgba(255, 255, 255, 0.96)';
  const tooltipTextColor = isDarkUi ? '#e5e7eb' : '#1f2937';
  const borderColor = isDarkUi ? '#374151' : '#e5e7eb';

  const empty = modelPieRows.length === 0;

  const data = useMemo(() => {
    if (empty) {
      return {
        labels: [''],
        datasets: [
          {
            data: [1],
            backgroundColor: [emptyFill],
            borderWidth: 0,
            hoverOffset: 0,
          },
        ],
      };
    }
    return {
      labels: modelPieRows.map((r) => r.type),
      datasets: [
        {
          label: seriesNameAllTime,
          data: modelPieRows.map((r) => r.value),
          backgroundColor: colors.slice(0, modelPieRows.length),
          borderColor: isDarkUi ? '#0f172a' : '#f8fafc',
          borderWidth: 1,
        },
      ],
    };
  }, [empty, emptyFill, modelPieRows, seriesNameAllTime, colors, isDarkUi]);

  const options = useMemo(
    (): ChartOptions<'doughnut'> => ({
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      spacing: chartLayoutNarrow ? 1 : 2,
      layout: {
        padding:
          chartLayoutNarrow ?
            { bottom: 8 }
          : { left: 4, top: 4, bottom: 4, right: 10 },
      },
      plugins: {
        legend: {
          display: empty ? false : true,
          ...(chartLayoutNarrow
            ? {
                position: 'bottom',
                labels: {
                  boxWidth: 10,
                  boxHeight: 10,
                  padding: 8,
                  color: legendTextColor,
                  font: { size: 11 },
                },
              }
            : {
                position: 'left',
                align: 'start',
                labels: {
                  padding: 10,
                  color: legendTextColor,
                },
              }),
        },
        tooltip: {
          enabled: !empty,
          backgroundColor: tooltipBg,
          titleColor: tooltipTextColor,
          bodyColor: tooltipTextColor,
          borderColor,
          borderWidth: 1,
          padding: 10,
          displayColors: true,
          callbacks: {
            title: (items) => (items.length && items[0].label ? String(items[0].label) : ''),
            label: (items) => {
              const slice = typeof items.raw === 'number' ? items.raw : 0;
              const sum =
                modelPieTotal > 0 ? modelPieTotal : modelPieRows.reduce((a, r) => a + r.value, 0);
              const percent = sum > 0 ? (slice / sum) * 100 : 0;
              return `${formatTokenCount(slice)} (${percent.toFixed(1)}%)`;
            },
          },
        },
      },
      cutout: chartLayoutNarrow ? '56%' : '52%',
      interaction: empty
        ? { mode: 'nearest' as const, intersect: false }
        : { mode: 'point' as const, intersect: true },
    }),
    [
      empty,
      chartLayoutNarrow,
      modelPieTotal,
      legendTextColor,
      tooltipBg,
      tooltipTextColor,
      borderColor,
      modelPieRows,
    ],
  );

  return (
    <div
      className={`flex min-h-0 min-w-0 flex-1 flex-col ${className ?? ''}`}
      style={{ width: '100%', height: '100%', minHeight: 0, ...style }}
    >
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center px-2 py-1">
        <div className="mx-auto aspect-square w-[70%] min-w-0 max-w-full shrink-0">
          <Doughnut data={data} options={options} />
        </div>
      </div>
    </div>
  );
}

function createStackTotalsPlugin(
  promptData: number[],
  completionData: number[],
  chartLayoutNarrow: boolean,
  totalLabelColor: string,
): Plugin<'bar'> {
  return {
    id: 'openpawStackTotals',
    afterDatasetsDraw(chart: ChartType<'bar'>) {
      const { ctx } = chart;
      const meta = chart.getDatasetMeta(1);
      if (!meta?.data?.length) return;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.font = `${chartLayoutNarrow ? 600 : 600} ${chartLayoutNarrow ? 9 : 11}px system-ui, sans-serif`;
      ctx.fillStyle = totalLabelColor;
      const offset = chartLayoutNarrow ? 2 : 6;
      meta.data.forEach((el, i) => {
        const total = (promptData[i] ?? 0) + (completionData[i] ?? 0);
        if (total <= 0) return;
        const bar = el as { x?: number; y?: number; base?: number };
        const x = bar.x;
        if (typeof x !== 'number') return;
        const y = typeof bar.y === 'number' ? bar.y : 0;
        const base = typeof bar.base === 'number' ? bar.base : y;
        const topY = Math.min(y, base) - offset;
        ctx.fillText(formatTokenCount(total), x, topY);
      });
      ctx.restore();
    },
  };
}

export type DailyTokenStackedBarProps = {
  chartLayoutNarrow: boolean;
  isDarkUi: boolean;
  history: UsageDay[];
  promptLabel: string;
  completionLabel: string;
  className?: string;
  style?: CSSProperties;
};

export function DailyTokenStackedBarChart({
  chartLayoutNarrow,
  isDarkUi,
  history,
  promptLabel,
  completionLabel,
  className,
  style,
}: DailyTokenStackedBarProps) {
  const axisLabelColor = isDarkUi ? '#9ca3af' : '#6b7280';
  const totalLabelColor = isDarkUi ? '#e5e7eb' : '#374151';
  const legendTextColor = isDarkUi ? '#d1d5db' : '#4b5563';
  const tooltipTextColor = isDarkUi ? '#e5e7eb' : '#1f2937';
  const tooltipBg = isDarkUi ? 'rgba(17, 24, 39, 0.92)' : 'rgba(255, 255, 255, 0.96)';
  const splitLineColor = isDarkUi ? '#374151' : '#e5e7eb';

  const xCategories = history.map((d) => d.date.slice(5));
  const promptData = history.map((d) => d.prompt_tokens ?? 0);
  const completionData = history.map((d) => d.completion_tokens ?? 0);

  const barSlotPx = chartLayoutNarrow ? 28 : undefined;
  const scrollInnerWidth =
    chartLayoutNarrow && barSlotPx
      ? Math.max(320, xCategories.length * barSlotPx + 80)
      : undefined;

  const totalsPlugin = useMemo(
    () => createStackTotalsPlugin(promptData, completionData, chartLayoutNarrow, totalLabelColor),
    [promptData, completionData, chartLayoutNarrow, totalLabelColor],
  );

  const data = useMemo(
    () => ({
      labels: xCategories,
      datasets: [
        {
          label: promptLabel,
          data: promptData,
          backgroundColor: '#3b82f6',
          borderWidth: 0,
          stack: 'tokens',
          maxBarThickness: chartLayoutNarrow ? 22 : 44,
        },
        {
          label: completionLabel,
          data: completionData,
          backgroundColor: '#22c55e',
          borderWidth: 0,
          stack: 'tokens',
          maxBarThickness: chartLayoutNarrow ? 22 : 44,
        },
      ],
    }),
    [
      xCategories,
      promptData,
      completionData,
      promptLabel,
      completionLabel,
      chartLayoutNarrow,
    ],
  );

  const options = useMemo(
    (): ChartOptions<'bar'> => ({
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      indexAxis: 'x',
      datasets: {
        bar: {
          categoryPercentage: 0.76,
          barPercentage: chartLayoutNarrow ? 0.85 : 0.92,
        },
      },
      layout: chartLayoutNarrow
        ? { padding: { top: 42, bottom: 4, left: 0, right: 0 } }
        : { padding: { top: 8, bottom: 4 } },
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: {
          display: true,
          position: chartLayoutNarrow ? 'top' : 'bottom',
          align: 'center',
          labels: {
            padding: chartLayoutNarrow ? 12 : 16,
            color: legendTextColor,
            font: { size: chartLayoutNarrow ? 11 : 12 },
            boxWidth: 12,
            boxHeight: 12,
          },
        },
        tooltip: {
          backgroundColor: tooltipBg,
          titleColor: tooltipTextColor,
          bodyColor: tooltipTextColor,
          borderColor: isDarkUi ? '#374151' : '#e5e7eb',
          borderWidth: 1,
          padding: 10,
          callbacks: {
            label: (ctx) => {
              const v = Number(ctx.raw ?? 0);
              const name = ctx.dataset.label ?? '';
              return `${name}: ${formatTokenCount(v)}`;
            },
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          ticks: {
            maxRotation: chartLayoutNarrow ? 0 : 38,
            minRotation: chartLayoutNarrow ? 0 : 38,
            color: axisLabelColor,
            autoSkipPadding: chartLayoutNarrow ? 10 : 20,
            font: { size: chartLayoutNarrow ? 10 : 12 },
          },
          border: { display: false },
        },
        y: {
          stacked: true,
          border: { display: false },
          ticks: {
            color: axisLabelColor,
            callback: (v) => formatTokenCount(Number(v)),
          },
          grid: { color: splitLineColor },
        },
      },
    }),
    [
      axisLabelColor,
      legendTextColor,
      tooltipBg,
      tooltipTextColor,
      splitLineColor,
      isDarkUi,
      chartLayoutNarrow,
    ],
  );

  const chart = (
    <Bar
      data={data}
      options={options}
      plugins={[totalsPlugin]}
      style={{ width: scrollInnerWidth ? scrollInnerWidth : '100%', height: '100%' }}
    />
  );

  return (
    <div className={`min-h-0 min-w-0 flex-1 ${className ?? ''}`} style={style}>
      {chartLayoutNarrow && scrollInnerWidth ? (
        <div className="h-full w-full overflow-x-auto overflow-y-hidden pb-1">
          <div className="h-full min-h-[236px]" style={{ width: scrollInnerWidth, minWidth: '100%' }}>
            {chart}
          </div>
        </div>
      ) : (
        <div className="h-full min-h-[236px] w-full">{chart}</div>
      )}
    </div>
  );
}

export type DailyTokenSparklineProps = {
  isDarkUi: boolean;
  history: UsageDay[];
  className?: string;
  style?: CSSProperties;
};

export function DailyTokenSparklineChart({
  isDarkUi,
  history,
  className,
  style,
}: DailyTokenSparklineProps) {
  const dates = history.map((d) => d.date.slice(5));
  const values = history.map((d) => d.total_tokens ?? 0);
  const tooltipBg = isDarkUi ? 'rgba(17, 24, 39, 0.92)' : 'rgba(255, 255, 255, 0.96)';
  const tooltipTextColor = isDarkUi ? '#e5e7eb' : '#1f2937';

  const data = useMemo(
    () => ({
      labels: dates,
      datasets: [
        {
          data: values,
          borderColor: '#3b82f6',
          borderWidth: 1.5,
          fill: true,
          backgroundColor: 'rgba(59, 130, 246, 0.14)',
          pointRadius: 0,
          pointHoverRadius: 3,
          tension: 0.35,
          spanGaps: true,
        },
      ],
    }),
    [dates, values],
  );

  const options = useMemo(
    (): ChartOptions<'line'> => ({
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 2, left: 0, right: 0, bottom: 0 } },
      scales: {
        x: { display: false, grid: { display: false } },
        y: { display: false, grid: { display: false } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: tooltipBg,
          titleColor: tooltipTextColor,
          bodyColor: tooltipTextColor,
          borderColor: isDarkUi ? '#374151' : '#e5e7eb',
          borderWidth: 1,
          padding: 8,
          caretPadding: 4,
          intersect: false,
          axis: 'x',
          displayColors: false,
          callbacks: {
            title: (items) => (items.length ? String(items[0].label) : ''),
            label: (item) => {
              const py = item.parsed;
              const y =
                py && typeof py === 'object' && 'y' in py && typeof (py as { y: number }).y === 'number'
                  ? (py as { y: number }).y
                  : Number(item.raw ?? 0);
              return formatTokenCount(y);
            },
          },
        },
      },
      elements: {
        line: { borderJoinStyle: 'round' },
        point: { hitRadius: 8 },
      },
    }),
    [tooltipBg, tooltipTextColor, isDarkUi],
  );

  return (
    <div className={className} style={{ width: '100%', height: '100%', ...style }}>
      <ChartJsComponent type="line" data={data} options={options} />
    </div>
  );
}
