import { useCallback, type RefObject } from 'react';
import type ReactECharts from 'echarts-for-react';
import { useVisibleRAF } from '@/hooks/useVisibleRAF';

/**
 * Smooth-scrolls an ECharts time axis via requestAnimationFrame.
 * Updates xAxis min/max to [now - windowMs, now] every frame.
 *
 * The rAF loop is gated by `useVisibleRAF` — it only runs while `targetRef`
 * is intersecting the viewport. Pass a ref to the chart's wrapper element
 * so off-screen charts stop burning cycles.
 */
export function useEChartTimeScroll(
  chartRef: RefObject<ReactECharts | null>,
  windowMs: number,
  targetRef: RefObject<Element | null>,
): void {
  const tick = useCallback(() => {
    const instance = chartRef.current?.getEchartsInstance();
    if (instance) {
      const now = Date.now();
      instance.setOption({ xAxis: { min: now - windowMs, max: now } });
    }
  }, [chartRef, windowMs]);

  useVisibleRAF(targetRef, tick);
}
