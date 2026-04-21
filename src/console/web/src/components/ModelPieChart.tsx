import type { CSSProperties } from 'react';
import * as echarts from 'echarts';
import ReactECharts from 'echarts-for-react';

/** Same as `echarts.EChartsOption` (official examples use `import * as echarts from 'echarts'`). */
export type EChartsOption = echarts.EChartsOption;

export type ModelPieChartProps = {
  option: EChartsOption;
  className?: string;
  style?: CSSProperties;
};

export function ModelPieChart({ option, className, style }: ModelPieChartProps) {
  return (
    <ReactECharts
      option={option}
      className={className}
      style={style}
      opts={{ renderer: 'canvas' }}
      notMerge
      lazyUpdate
    />
  );
}
