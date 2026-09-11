import type { Ref } from 'react';
import type ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import EChartsLazy from '@/components/charts/EChartsLazy';

interface DualSeriesChartRendererProps {
  option: EChartsOption;
  ref?: Ref<ReactECharts>;
  notMerge?: boolean;
  replaceMerge?: string | string[];
}

export default function DualSeriesChartRenderer({ option, ref, notMerge = true, replaceMerge }: DualSeriesChartRendererProps) {
  return (
    <EChartsLazy
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
