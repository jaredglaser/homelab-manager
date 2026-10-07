import { useCallback, useState, type RefObject } from 'react';
import type ReactECharts from 'echarts-for-react';
import { useVisibleRAF } from '@/hooks/useVisibleRAF';

/**
 * Smooth-scrolls an ECharts time axis via requestAnimationFrame.
 * Updates xAxis min/max to [now - windowMs, now] every frame.
 *
 * The rAF loop is gated by `useVisibleRAF`: it only runs while `targetRef`
 * is intersecting the viewport. Pass a ref to the chart's wrapper element
 * so off-screen charts stop burning cycles.
 *
 * Returns the `onChartReady` callback: attach it to the ECharts element. The
 * tick only drives the exact instance the library reported ready, so the bare
 * temporary instance from the async init (or any later re-init) is never
 * touched. Merging xAxis-only into it crashes in CartesianAxisView.render.
 */
export function useEChartTimeScroll(
  chartRef: RefObject<ReactECharts | null>,
  windowMs: number,
  targetRef: RefObject<Element | null>,
): (readyInstance: unknown) => void {
  const [readyInstance, setReadyInstance] = useState<unknown>(null);
  const onChartReady = useCallback((instance: unknown) => setReadyInstance(instance), []);

  const tick = () => {
    const instance = chartRef.current?.getEchartsInstance();
    if (!instance || instance.isDisposed() || instance !== readyInstance) return;
    const now = Date.now();
    instance.setOption({ xAxis: { min: now - windowMs, max: now } });
  };

  useVisibleRAF(targetRef, tick);

  return onChartReady;
}
