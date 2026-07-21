import { lazy, Suspense } from 'react';
import { Spinner } from '@/components/ui/spinner';

const ComposeEditor = lazy(() => import('@/components/stacks/ComposeEditor'));

interface ComposeEditorLoaderProps {
  stackName: string;
}

export default function ComposeEditorLoader(props: Readonly<ComposeEditorLoaderProps>) {
  return (
    <Suspense
      fallback={
        <div className="p-8 mb-4 bg-chart-bg rounded-sm flex items-center justify-center gap-3">
          <Spinner className="size-5" />
          <p className="text-sm opacity-60">
            Loading editor...
          </p>
        </div>
      }
    >
      <ComposeEditor {...props} />
    </Suspense>
  );
}
