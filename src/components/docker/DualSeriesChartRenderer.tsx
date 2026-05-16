import type { Ref } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';

interface DualSeriesChartRendererProps {
  option: EChartsOption;
  ref?: Ref<ReactECharts>;
  notMerge?: boolean;
  replaceMerge?: string[];
}

export default function DualSeriesChartRenderer({ option, ref, notMerge = true, replaceMerge }: DualSeriesChartRendererProps) {
  return (
    <ReactECharts
      ref={ref}
      option={option}
      opts={{ renderer: 'canvas' }}
      notMerge={notMerge}
      replaceMerge={replaceMerge}
      lazyUpdate={true}
      className="h-full! w-full!"
    />
  );
}
