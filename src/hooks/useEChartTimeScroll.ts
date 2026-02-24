import { useEffect, type RefObject } from 'react';
import type ReactECharts from 'echarts-for-react';

/**
 * Smooth-scrolls an ECharts time axis via requestAnimationFrame.
 * Updates xAxis min/max to [now - windowMs, now] every frame.
 */
export function useEChartTimeScroll(
  chartRef: RefObject<ReactECharts | null>,
  windowMs: number,
): void {
  useEffect(() => {
    let rafId: number;
    const tick = () => {
      const instance = chartRef.current?.getEchartsInstance();
      if (instance) {
        const now = Date.now();
        instance.setOption({ xAxis: { min: now - windowMs, max: now } });
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [chartRef, windowMs]);
}
