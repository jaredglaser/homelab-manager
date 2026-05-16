import { useState } from 'react';
import { IconButton, CircularProgress } from '@mui/material';
import IconTooltip from '@/components/docker/IconTooltip';
import { Play, Square, RotateCcw } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { useToast } from '@/hooks/toastAtom';
import { controlContainer } from '@/data/docker/functions';

interface ContainerActionButtonsProps {
  containerId: string;
  host: string;
  isRunning: boolean;
}

type ContainerAction = 'start' | 'stop' | 'restart';

const ACTION_PAST: Record<ContainerAction, string> = {
  start: 'started',
  stop: 'stopped',
  restart: 'restarted',
};


export default function ContainerActionButtons({
  containerId,
  host,
  isRunning,
}: ContainerActionButtonsProps) {
  const { showToast } = useToast();
  const [pendingAction, setPendingAction] = useState<ContainerAction | null>(null);

  const mutation = useMutation({
    mutationFn: (action: ContainerAction) =>
      controlContainer({ data: { host, containerId, action } }),
    onSuccess: (_, action) => {
      showToast(`Container ${ACTION_PAST[action]}`, 'success');
      setPendingAction(null);
    },
    onError: (err, action) => {
      console.error(`[ContainerActionButtons] ${action} failed:`, err);
      showToast(
        `Failed to ${action} container: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      );
      setPendingAction(null);
    },
  });

  function trigger(action: ContainerAction) {
    setPendingAction(action);
    mutation.mutate(action);
  }

  const isPending = mutation.isPending;

  return (
    <div className="flex items-center gap-0.5">
      <IconTooltip label="Start">
        <IconButton
          size="small"
          className="p-1!"
          disabled={isRunning || isPending}
          onClick={() => trigger('start')}
          aria-label="Start container"
        >
          {pendingAction === 'start' ? (
            <CircularProgress size={14} className="!text-inherit" />
          ) : (
            <Play size={14} />
          )}
        </IconButton>
      </IconTooltip>
      <IconTooltip label="Stop">
        <IconButton
          size="small"
          className="p-1!"
          color={isRunning && !isPending ? 'error' : undefined}
          disabled={!isRunning || isPending}
          onClick={() => trigger('stop')}
          aria-label="Stop container"
        >
          {pendingAction === 'stop' ? (
            <CircularProgress size={14} className="!text-inherit" />
          ) : (
            <Square size={14} />
          )}
        </IconButton>
      </IconTooltip>
      <IconTooltip label="Restart">
        <IconButton
          size="small"
          className="p-1!"
          disabled={!isRunning || isPending}
          onClick={() => trigger('restart')}
          aria-label="Restart container"
        >
          {pendingAction === 'restart' ? (
            <CircularProgress size={14} className="!text-inherit" />
          ) : (
            <RotateCcw size={14} />
          )}
        </IconButton>
      </IconTooltip>
    </div>
  );
}
