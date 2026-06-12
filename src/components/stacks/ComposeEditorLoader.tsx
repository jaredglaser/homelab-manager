import { lazy, Suspense } from 'react';
import { Paper, Typography } from '@mui/material';
import { Spinner } from '@/components/ui/spinner';

const ComposeEditor = lazy(() => import('@/components/stacks/ComposeEditor'));

interface ComposeEditorLoaderProps {
  stackName: string;
  content: string;
}

export default function ComposeEditorLoader(props: Readonly<ComposeEditorLoaderProps>) {
  return (
    <Suspense
      fallback={
        <Paper elevation={0} className="p-8 mb-4 bg-(--mui-palette-background-chartBg)! rounded-sm flex items-center justify-center gap-3">
          <Spinner className="size-5" />
          <Typography variant="body2" className="opacity-60">
            Loading editor...
          </Typography>
        </Paper>
      }
    >
      <ComposeEditor {...props} />
    </Suspense>
  );
}
