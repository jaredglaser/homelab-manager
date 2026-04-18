import type { ContainerState } from '@/types/docker-inventory';

interface Props {
  state: ContainerState;
}

export default function ContainerStateChip({ state }: Readonly<Props>) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs font-medium"
      data-testid="container-state-chip"
      data-state={state}
    >
      <StateIndicator state={state} />
      <span className="text-[var(--mui-palette-text-secondary)]">{state}</span>
    </span>
  );
}

function StateIndicator({ state }: { state: ContainerState }) {
  if (state === 'running') {
    return (
      <span
        className="inline-block w-2 h-2 rounded-full bg-green-500"
        aria-label="running"
      />
    );
  }

  if (state === 'restarting') {
    return (
      <span
        className="inline-block w-2 h-2 rounded-full bg-yellow-400 animate-pulse"
        aria-label="restarting"
      />
    );
  }

  if (state === 'paused') {
    return (
      <span
        className="inline-block w-2 h-2 rounded-full bg-yellow-400"
        aria-label="paused"
      />
    );
  }

  if (state === 'exited' || state === 'dead') {
    return (
      <span
        className="inline-block w-2 h-2 rounded-full bg-[var(--mui-palette-action-disabled)]"
        aria-label={state}
      />
    );
  }

  // created, removing, unknown — outlined dot
  return (
    <span
      className="inline-block w-2 h-2 rounded-full border border-[var(--mui-palette-action-disabled)]"
      aria-label={state}
    />
  );
}
