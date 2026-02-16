import { useMemo } from 'react';
import { Box, Chip, Sheet, Typography } from '@mui/joy';
import { RefreshCw } from 'lucide-react';
import type { ProxmoxStatsFromDB } from '@/lib/transformers/proxmox-transformer';
import type { ProxmoxReplicationJob } from '@/types/proxmox';

interface ReplicationTableProps {
  stats: ProxmoxStatsFromDB[];
}

/** Parse replication metadata from entity stats into structured replication jobs. */
function extractReplicationJobs(_stats: ProxmoxStatsFromDB[]): ProxmoxReplicationJob[] {
  // Replication data is stored in entity_metadata. We need to collect
  // it from the stats objects which have been enriched with metadata.
  // The collector stores replication info as JSON in the 'replication' and 'replication_status'
  // metadata keys. Since we read from entity_metadata through the transformer,
  // we need to reconstruct the information here.
  //
  // Note: The metadata is not directly available on ProxmoxStatsFromDB.
  // For now, return empty — replication data will be visible once the
  // subscription service enriches the cache with metadata.
  return [];
}

export default function ReplicationTable({ stats }: ReplicationTableProps) {
  const jobs = useMemo(() => extractReplicationJobs(stats), [stats]);

  // Count guests that are on different nodes (potential migration candidates)
  const guestsByNode = useMemo(() => {
    const byNode = new Map<string, ProxmoxStatsFromDB[]>();
    for (const stat of stats) {
      if (stat.entityType === 'node') continue;
      const existing = byNode.get(stat.node) ?? [];
      existing.push(stat);
      byNode.set(stat.node, existing);
    }
    return byNode;
  }, [stats]);

  return (
    <Box className="mt-6">
      <Typography level="h4" className="mb-3 flex items-center gap-2">
        <RefreshCw size={20} />
        Cluster Overview
      </Typography>

      {/* Guest Distribution */}
      <Sheet variant="outlined" className="rounded-sm overflow-hidden mb-4">
        <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-700">
          <Typography level="title-md">Guest Distribution</Typography>
        </div>
        <div className="grid grid-cols-[1fr_80px_80px_80px] min-w-[400px]">
          <div className="px-3 py-1.5 font-semibold text-xs border-b border-neutral-200 dark:border-neutral-700">Node</div>
          <div className="px-3 py-1.5 font-semibold text-xs text-right border-b border-neutral-200 dark:border-neutral-700">VMs</div>
          <div className="px-3 py-1.5 font-semibold text-xs text-right border-b border-neutral-200 dark:border-neutral-700">LXCs</div>
          <div className="px-3 py-1.5 font-semibold text-xs text-right border-b border-neutral-200 dark:border-neutral-700">Total</div>

          {Array.from(guestsByNode.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([node, guests]) => {
              const vms = guests.filter(g => g.entityType === 'qemu').length;
              const lxcs = guests.filter(g => g.entityType === 'lxc').length;
              return (
                <NodeDistributionRow
                  key={node}
                  node={node}
                  vms={vms}
                  lxcs={lxcs}
                  total={guests.length}
                />
              );
            })}
        </div>
      </Sheet>

      {/* Replication Jobs */}
      {jobs.length > 0 && (
        <Sheet variant="outlined" className="rounded-sm overflow-hidden mb-4">
          <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-700">
            <Typography level="title-md">Replication Jobs</Typography>
          </div>
          <div className="grid grid-cols-[1fr_1fr_80px_100px_100px_80px] min-w-[600px]">
            <div className="px-3 py-1.5 font-semibold text-xs border-b border-neutral-200 dark:border-neutral-700">Guest</div>
            <div className="px-3 py-1.5 font-semibold text-xs border-b border-neutral-200 dark:border-neutral-700">Target</div>
            <div className="px-3 py-1.5 font-semibold text-xs border-b border-neutral-200 dark:border-neutral-700">Type</div>
            <div className="px-3 py-1.5 font-semibold text-xs border-b border-neutral-200 dark:border-neutral-700">Schedule</div>
            <div className="px-3 py-1.5 font-semibold text-xs border-b border-neutral-200 dark:border-neutral-700">Last Sync</div>
            <div className="px-3 py-1.5 font-semibold text-xs border-b border-neutral-200 dark:border-neutral-700">Status</div>

            {jobs.map(job => (
              <ReplicationJobRow key={job.id} job={job} />
            ))}
          </div>
        </Sheet>
      )}

      {jobs.length === 0 && (
        <Typography level="body-sm" color="neutral" className="mt-2">
          No replication jobs configured in this cluster.
        </Typography>
      )}
    </Box>
  );
}

function NodeDistributionRow({ node, vms, lxcs, total }: { node: string; vms: number; lxcs: number; total: number }) {
  return (
    <>
      <div className="px-3 py-1.5 text-sm font-semibold">{node}</div>
      <div className="px-3 py-1.5 text-sm text-right tabular-nums">{vms}</div>
      <div className="px-3 py-1.5 text-sm text-right tabular-nums">{lxcs}</div>
      <div className="px-3 py-1.5 text-sm text-right tabular-nums font-semibold">{total}</div>
    </>
  );
}

function ReplicationJobRow({ job }: { job: ProxmoxReplicationJob }) {
  const lastSyncStr = job.lastSync
    ? new Date(job.lastSync * 1000).toLocaleString()
    : '—';

  const statusColor = job.failCount > 0 ? 'danger' : 'success';
  const statusLabel = job.failCount > 0 ? `${job.failCount} failures` : 'OK';

  return (
    <>
      <div className="px-3 py-1.5 text-sm">{job.guestName} ({job.guest})</div>
      <div className="px-3 py-1.5 text-sm">{job.target}</div>
      <div className="px-3 py-1.5 text-sm">{job.type}</div>
      <div className="px-3 py-1.5 text-sm font-mono">{job.schedule}</div>
      <div className="px-3 py-1.5 text-sm">{lastSyncStr}</div>
      <div className="px-3 py-1.5">
        <Chip size="sm" variant="soft" color={statusColor}>{statusLabel}</Chip>
      </div>
    </>
  );
}
