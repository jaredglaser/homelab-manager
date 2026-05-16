import { useState } from 'react';
import { IconButton, CircularProgress } from '@mui/material';
import { Play, Square, RotateCcw } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { useToast } from '@/hooks/toastAtom';
import { controlContainer } from '@/data/docker/functions';

interface ContainerActionButtonsProps {
  containerId: string;
  host: string;
  isRunning: boolean;
  /** Icon-only compact mode for modal header; default is text+icon mode for status strip. */
  compact?: boolean;
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
  compact = false,
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

  if (compact) {
    return (
      <div className="flex items-center gap-0.5">
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
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <ActionButton
        icon={pendingAction === 'start' ? <CircularProgress size={12} className="!text-inherit" /> : <Play size={12} />}
        label="Start"
        disabled={isRunning || isPending}
        onClick={() => trigger('start')}
        aria-label="Start container"
      />
      <ActionButton
        icon={pendingAction === 'stop' ? <CircularProgress size={12} className="!text-inherit" /> : <Square size={12} />}
        label="Stop"
        disabled={!isRunning || isPending}
        danger
        onClick={() => trigger('stop')}
        aria-label="Stop container"
      />
      <ActionButton
        icon={pendingAction === 'restart' ? <CircularProgress size={12} className="!text-inherit" /> : <RotateCcw size={12} />}
        label="Restart"
        disabled={!isRunning || isPending}
        onClick={() => trigger('restart')}
        aria-label="Restart container"
      />
    </div>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  disabled,
  danger,
  'aria-label': ariaLabel,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  'aria-label': string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={[
        'inline-flex items-center gap-1 px-2 h-[28px] rounded text-xs font-medium',
        'border border-(--mui-palette-divider) bg-transparent',
        'transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer',
        danger ? 'text-(--mui-palette-error-main)' : 'text-(--mui-palette-text-secondary)',
      ].join(' ')}
    >
      {icon}
      {label}
    </button>
  );
}
