import { useMemo } from 'react';
import { Typography } from '@mui/material';
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
      <Typography
        component="span"
        variant="inherit"
        className="font-mono tabular-nums text-[var(--mui-palette-text-primary)]"
      >
        {count}
      </Typography>
      {' '}
      <Typography
        component="span"
        variant="inherit"
        className="text-[var(--mui-palette-text-secondary)]"
      >
        {label}
      </Typography>
    </span>
  );
}

export default function ZFSStatusSummary({ latestByEntity }: Readonly<ZFSStatusSummaryProps>) {
  const counts = useMemo(() => {
    let pools = 0;
    let disks = 0;
    const hosts = new Set<string>();

    for (const row of latestByEntity.values()) {
      hosts.add(row.host);
      if (row.entity_type === 'pool') {
        pools++;
      } else if (row.entity_type === 'disk') {
        disks++;
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
            <Typography
              component="span"
              variant="inherit"
              className="text-[var(--mui-palette-text-disabled)] select-none"
            >
              ·
            </Typography>
          )}
          <StatusSegment label={seg.label} count={seg.count} />
        </span>
      ))}
    </span>
  );
}
