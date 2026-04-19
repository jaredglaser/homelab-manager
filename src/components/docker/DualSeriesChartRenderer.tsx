import type { Ref } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';

interface DualSeriesChartRendererProps {
  option: EChartsOption;
  ref?: Ref<ReactECharts>;
}

export default function DualSeriesChartRenderer({ option, ref }: DualSeriesChartRendererProps) {
  return (
    <ReactECharts
      ref={ref}
      option={option}
      opts={{ renderer: 'canvas' }}
      notMerge={false}
      lazyUpdate={true}
      className="!h-full !w-full"
    />
  );
}
