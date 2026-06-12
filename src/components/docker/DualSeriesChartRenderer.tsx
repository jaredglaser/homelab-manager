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
      // echarts-for-react sets inline height/width on its wrapper div; the
      // important postfix is required to beat inline styles (cascade layers don't).
      className="h-full! w-full!"
    />
  );
}
