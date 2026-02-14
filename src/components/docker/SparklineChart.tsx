import { memo, useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';

interface SparklineChartProps {
  data: number[];
  color: string;
  height?: number;
  width?: number;
  className?: string;
}

function getCssVar(name: string): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export default memo(function SparklineChart({
  data,
  color,
  height = 24,
  width = 60,
  className,
}: SparklineChartProps) {
  const option: EChartsOption = useMemo(() => {
    const lineColor = getCssVar(color);
    const areaStart = getCssVar(`${color}-area-start`);
    const areaEnd = getCssVar(`${color}-area-end`);

    return {
      animation: false,
      grid: {
        top: 2,
        right: 2,
        bottom: 2,
        left: 2,
      },
      xAxis: {
        type: 'category',
        show: false,
        data: data.map((_, i) => i),
      },
      yAxis: {
        type: 'value',
        show: false,
        min: 0,
        max: (value) => Math.max(value.max * 1.1, 1),
      },
      series: [
        {
          type: 'line',
          smooth: false,
          showSymbol: false,
          data,
          lineStyle: { color: lineColor, width: 1.5 },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: areaStart },
                { offset: 1, color: areaEnd },
              ],
            },
          },
        },
      ],
    };
  }, [data, color]);

  return (
    <div className={className}>
      <ReactECharts
        option={option}
        style={{ height, width }}
        opts={{ renderer: 'svg' }}
        notMerge={false}
        lazyUpdate={true}
      />
    </div>
  );
});
