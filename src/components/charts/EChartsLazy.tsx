import { lazy, Suspense, type ComponentProps } from 'react';

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

// lazy() components cannot take ref pre-React-19; React 19's ref-as-prop (used by this app's consumers) passes through {...props}.
export default EChartsLazy;
