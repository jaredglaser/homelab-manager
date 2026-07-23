import { useMemo } from 'react';
import type { ZFSStatsRow } from '@/types/zfs';

interface ZFSStatusSummaryProps {
  latestByEntity: Map<string, ZFSStatsRow>;
}

interface Segment {
  label: string;
  count: number;
}

function StatusSegment({ label, count }: Readonly<Segment>) {
  return (
    <span>
      <span className="text-base font-mono tabular-nums text-foreground">
        {count}
      </span>
      {' '}
      <span className="text-base text-(--muted-foreground)">
        {label}
      </span>
    </span>
  );
}

export default function ZFSStatusSummary({ latestByEntity }: Readonly<ZFSStatusSummaryProps>) {
  const counts = useMemo(() => {
    let pools = 0;
    let disks = 0;
    const hosts = new Set<string>();

    for (const row of latestByEntity.values()) {
      // Only count hosts that contribute to displayed segments (pools/disks).
      // Intermediate 'vdev' rows shouldn't inflate the host count.
      if (row.entity_type === 'pool') {
        pools++;
        hosts.add(row.host);
      } else if (row.entity_type === 'disk') {
        disks++;
        hosts.add(row.host);
      }
    }

    return { pools, disks, hostCount: hosts.size };
  }, [latestByEntity]);

  const segments: Segment[] = [];

  segments.push({ label: 'pools', count: counts.pools });

  if (counts.disks > 0) segments.push({ label: 'disks', count: counts.disks });
  if (counts.hostCount > 0) segments.push({ label: 'hosts', count: counts.hostCount });

  return (
    <span className="flex items-center gap-2 flex-wrap">
      {segments.map((seg, i) => (
        <span key={seg.label} className="flex items-center gap-2">
          {i > 0 && (
            <span className="text-base text-(--text-disabled) select-none">
              ·
            </span>
          )}
          <StatusSegment label={seg.label} count={seg.count} />
        </span>
      ))}
    </span>
  );
}
