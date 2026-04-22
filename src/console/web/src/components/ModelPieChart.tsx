import { useEffect, useRef, type CSSProperties } from 'react';
import * as echarts from 'echarts';
import ReactECharts from 'echarts-for-react';

/** Same as `echarts.EChartsOption` (official examples use `import * as echarts from 'echarts'`). */
export type EChartsOption = echarts.EChartsOption;

export type EChartsWithResizeProps = {
  option: EChartsOption;
  className?: string;
  style?: CSSProperties;
  /** Forwarded to echarts-for-react (e.g. `{ click: (p) => ... }`). */
  onEvents?: Record<string, (params: unknown) => void>;
};

/**
 * Wraps echarts-for-react so the canvas tracks container size after flex/grid or window changes.
 */
export function EChartsWithResize({ option, className, style, onEvents }: EChartsWithResizeProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const ro = new ResizeObserver(() => {
      instanceRef.current?.resize();
    });
    ro.observe(shell);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={shellRef} className="h-full w-full min-h-0 min-w-0 overflow-visible">
      <ReactECharts
        option={option}
        className={className}
        style={{ width: '100%', height: '100%', ...style }}
        opts={{ renderer: 'canvas' }}
        notMerge
        lazyUpdate
        onEvents={onEvents}
        onChartReady={(chart) => {
          instanceRef.current = chart;
          chart.resize();
        }}
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
