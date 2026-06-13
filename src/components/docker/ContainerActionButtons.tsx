import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
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
        <Button
          variant="ghost"
          size="icon-sm"
          className="p-1!"
          disabled={isRunning || isPending}
          onClick={() => trigger('start')}
          aria-label="Start container"
        >
          {pendingAction === 'start' ? (
            <Spinner className="size-3.5 text-current" />
          ) : (
            <Play size={14} />
          )}
        </Button>
      </IconTooltip>
      <IconTooltip label="Stop">
        <Button
          variant="ghost"
          size="icon-sm"
          className={`p-1! ${isRunning && !isPending ? 'text-destructive' : ''}`}
          disabled={!isRunning || isPending}
          onClick={() => trigger('stop')}
          aria-label="Stop container"
        >
          {pendingAction === 'stop' ? (
            <Spinner className="size-3.5 text-current" />
          ) : (
            <Square size={14} />
          )}
        </Button>
      </IconTooltip>
      <IconTooltip label="Restart">
        <Button
          variant="ghost"
          size="icon-sm"
          className="p-1!"
          disabled={!isRunning || isPending}
          onClick={() => trigger('restart')}
          aria-label="Restart container"
        >
          {pendingAction === 'restart' ? (
            <Spinner className="size-3.5 text-current" />
          ) : (
            <RotateCcw size={14} />
          )}
        </Button>
      </IconTooltip>
    </div>
  );
}
