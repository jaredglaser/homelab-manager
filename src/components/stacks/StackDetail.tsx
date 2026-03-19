import { CircularProgress } from '@mui/material';

interface StackDetailProps {
  stackName: string;
}

/** Placeholder for the full stack detail panel (implemented in a later chunk). */
export default function StackDetail({ stackName }: StackDetailProps) {
  return (
    <div className="p-4 border-t border-neutral-200 dark:border-neutral-700 bg-[var(--mui-palette-background-level1)]">
      <div className="flex items-center gap-2 text-sm opacity-70">
        <CircularProgress size={16} />
        <span>Loading details for {stackName}...</span>
      </div>
    </div>
  );
}
