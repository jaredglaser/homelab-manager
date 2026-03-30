import { lazy, Suspense } from 'react';
import { CircularProgress, Paper, Typography } from '@mui/material';

const ComposeEditor = lazy(() => import('@/components/stacks/ComposeEditor'));

interface ComposeEditorLoaderProps {
  host: string;
  stackName: string;
  content: string;
  variables: string[];
}

export default function ComposeEditorLoader(props: Readonly<ComposeEditorLoaderProps>) {
  return (
    <Suspense
      fallback={
        <Paper elevation={0} className="p-8 mb-4 !bg-[var(--mui-palette-background-chartBg)] rounded-sm flex items-center justify-center gap-3">
          <CircularProgress size={20} />
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
