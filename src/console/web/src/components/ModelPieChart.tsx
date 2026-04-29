import { useEffect, useRef, type CSSProperties } from 'react';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import {
  BarChart,
  CustomChart,
  LineChart,
  PieChart,
} from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components';
import type {
  ComposeOption,
  EChartsCoreOption,
  ECharts,
  SetOptionOpts,
} from 'echarts/core';
import type {
  BarSeriesOption,
  CustomSeriesOption,
  LineSeriesOption,
  PieSeriesOption,
} from 'echarts/charts';
import type {
  DataZoomComponentOption,
  GridComponentOption,
  LegendComponentOption,
  TitleComponentOption,
  TooltipComponentOption,
} from 'echarts/components';
import { LegacyGridContainLabel } from 'echarts/features';

// Register only the chart types and components we actually use across the
// app (Dashboard pie/bar/line, TraceGanttChart custom). Pulling the full
// `echarts` package adds ~700 kB to the bundle for features we never use.
let echartsRegistered = false;
function ensureEchartsRegistered() {
  if (echartsRegistered) return;
  echartsRegistered = true;
  echarts.use([
    CanvasRenderer,
    PieChart,
    BarChart,
    LineChart,
    CustomChart,
    TitleComponent,
    TooltipComponent,
    LegendComponent,
    GridComponent,
    DataZoomComponent,
    LegacyGridContainLabel,
  ]);
}

/**
 * Strongly-typed option that includes only the series + components we have
 * registered above. Keeping this narrow ensures dead-code elimination keeps
 * working: any new usage forces an explicit `echarts.use(...)` update here.
 */
export type EChartsOption = ComposeOption<
  | BarSeriesOption
  | CustomSeriesOption
  | LineSeriesOption
  | PieSeriesOption
  | DataZoomComponentOption
  | GridComponentOption
  | LegendComponentOption
  | TitleComponentOption
  | TooltipComponentOption
>;

export type EChartsWithResizeProps = {
  option: EChartsOption;
  className?: string;
  style?: CSSProperties;
  /** Forwarded to the underlying chart (e.g. `{ click: (p) => ... }`). */
  onEvents?: Record<string, (params: unknown) => void>;
};

const DEFAULT_SET_OPTS: SetOptionOpts = { notMerge: true, lazyUpdate: true };

/**
 * Imperative wrapper around echarts/core. We deliberately avoid
 * `echarts-for-react` so the build does not transitively pull the full
 * `echarts` umbrella package, and so we keep tighter control over resize
 * + event lifecycles.
 */
export function EChartsWithResize({ option, className, style, onEvents }: EChartsWithResizeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<ECharts | null>(null);
  const eventsRef = useRef<Record<string, (params: unknown) => void> | undefined>(onEvents);

  // Keep the latest event handlers without recreating the chart.
  eventsRef.current = onEvents;

  useEffect(() => {
    ensureEchartsRegistered();
    const el = containerRef.current;
    if (!el) return;
    const chart = echarts.init(el, undefined, { renderer: 'canvas' });
    instanceRef.current = chart;

    // Bridge a stable handler list to the latest ref so consumers can pass
    // inline lambdas without churning the chart on every parent re-render.
    const bound = new Map<string, (params: unknown) => void>();
    const installHandlers = () => {
      for (const [name, handler] of bound) {
        chart.off(name, handler);
      }
      bound.clear();
      const next = eventsRef.current;
      if (!next) return;
      for (const name of Object.keys(next)) {
        const proxy = (params: unknown) => eventsRef.current?.[name]?.(params);
        chart.on(name, proxy);
        bound.set(name, proxy);
      }
    };
    installHandlers();

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);

    return () => {
      ro.disconnect();
      for (const [name, handler] of bound) {
        chart.off(name, handler);
      }
      bound.clear();
      chart.dispose();
      instanceRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = instanceRef.current;
    if (!chart) return;
    chart.setOption(option as EChartsCoreOption, DEFAULT_SET_OPTS);
  }, [option]);

  return (
    <div className="h-full w-full min-h-0 min-w-0 overflow-visible">
      <div
        ref={containerRef}
        className={className}
        style={{ width: '100%', height: '100%', ...style }}
      />
    </div>
  );
}

export type ModelPieChartProps = {
  option: EChartsOption;
  className?: string;
  style?: CSSProperties;
};

export function ModelPieChart({ option, className, style }: ModelPieChartProps) {
  return <EChartsWithResize option={option} className={className} style={style} />;
}
