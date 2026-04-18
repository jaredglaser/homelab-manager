import { forwardRef } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';

interface DualSeriesChartRendererProps {
  option: EChartsOption;
}

/**
 * Thin wrapper over the echarts-for-react component. Extracted so tests
 * can mock this narrow, project-local module without touching the
 * global `echarts-for-react` import.
 */
const DualSeriesChartRenderer = forwardRef<ReactECharts, DualSeriesChartRendererProps>(
  function DualSeriesChartRenderer({ option }, ref) {
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
  },
);

export default DualSeriesChartRenderer;
