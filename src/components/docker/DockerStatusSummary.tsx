import { useMemo } from 'react';
import { bucketContainerState } from '@/lib/utils/docker-hierarchy-builder';
import type { DockerInventorySnapshotContainer } from '@/types/docker-inventory';

interface Segment {
  label: string;
  count: number;
}

function StatusSegment({ label, count }: Readonly<Segment>) {
  return (
    <span>
      <span className="text-base font-mono tabular-nums text-(--mui-palette-text-primary)">
        {count}
      </span>
      {' '}
      <span className="text-base text-(--mui-palette-text-secondary)">
        {label}
      </span>
    </span>
  );
}

interface DockerStatusSummaryProps {
  inventory: Map<string, DockerInventorySnapshotContainer>;
}

export default function DockerStatusSummary({ inventory }: Readonly<DockerStatusSummaryProps>) {
  const counts = useMemo(() => {
    const states = { running: 0, stopped: 0, restarting: 0, paused: 0, other: 0 };
    const hosts = new Set<string>();
    for (const row of inventory.values()) {
      hosts.add(row.host);
      const bucket = bucketContainerState(row.state);
      states[bucket]++;
    }
    return { ...states, hostCount: hosts.size };
  }, [inventory]);

  const segments: Segment[] = [];

  segments.push({ label: 'running', count: counts.running });

  if (counts.stopped > 0) segments.push({ label: 'stopped', count: counts.stopped });
  if (counts.restarting > 0) segments.push({ label: 'restarting', count: counts.restarting });
  if (counts.paused > 0) segments.push({ label: 'paused', count: counts.paused });
  if (counts.other > 0) segments.push({ label: 'other', count: counts.other });
  if (counts.hostCount > 0) segments.push({ label: 'hosts', count: counts.hostCount });

  return (
    <span className="flex items-center gap-2 flex-wrap">
      {segments.map((seg, i) => (
        <span key={seg.label} className="flex items-center gap-2">
          {i > 0 && (
            <span className="text-base text-(--mui-palette-text-disabled) select-none">
              ·
            </span>
          )}
          <StatusSegment label={seg.label} count={seg.count} />
        </span>
      ))}
    </span>
  );
}
