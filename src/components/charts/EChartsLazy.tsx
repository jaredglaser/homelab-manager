/**
 * Lazy wrapper around echarts-for-react's ReactECharts.
 *
 * echarts is a large library (~700 kB minified) that was previously bundled
 * statically into the main entry chunk, so every page load — including pages
 * with no charts — paid the cost. This wrapper dynamic-imports it on first
 * render so the bundler emits a separate chunk that is only fetched when a
 * chart actually mounts.
 *
 * Usage: drop-in replacement for `ReactECharts` — same props, same ref.
 * While loading it renders `fallback` (default: nothing).
 */
import { lazy, Suspense, type ComponentProps } from 'react';

// Named re-exports of echarts-for-react used by chart components for ref types.
export type { default as ReactECharts } from 'echarts-for-react';

const LazyReactECharts = lazy(() => import('echarts-for-react'));

export type EChartsLazyProps = ComponentProps<typeof LazyReactECharts> & {
  fallback?: React.ReactNode;
};

function EChartsLazy({ fallback = null, ...props }: EChartsLazyProps) {
  return (
    <Suspense fallback={fallback}>
      <LazyReactECharts {...props} />
    </Suspense>
  );
}

// Ref forwarding: ReactECharts instances are grabbed via ref by several chart
// components (time-scroll handling). lazy() components can't take ref directly
// pre-React-19; React 19 does support ref as a prop, which this app uses.
export default EChartsLazy;
