import { Typography } from '@mui/material';
import type { StackContainer } from '@/types/stacks';

interface ContainerListProps {
  containers: StackContainer[];
}

export default function ContainerList({ containers }: ContainerListProps) {
  if (containers.length === 0) {
    return (
      <Typography variant="body2" className="opacity-50 py-2">
        No container data.
      </Typography>
    );
  }

  return (
    <div className="space-y-1">
      {containers.map((container) => {
        const isRunning = container.status === 'running';
        return (
          <div key={container.id} className="flex items-center gap-2 text-sm py-1">
            <span
              className={`w-2 h-2 rounded-full flex-shrink-0 ${isRunning ? 'bg-green-500' : 'bg-red-500'}`}
              aria-label={isRunning ? 'running' : 'not running'}
            />
            <span className="font-medium truncate">{container.name}</span>
            <span className="opacity-50 text-xs truncate">{container.status}</span>
          </div>
        );
      })}
    </div>
  );
}
