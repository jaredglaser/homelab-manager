import { useMemo } from 'react';
import { Box, Chip, Sheet, Typography } from '@mui/joy';
import { Globe } from 'lucide-react';
import type { ProxmoxStatsFromDB } from '@/lib/transformers/proxmox-transformer';
import type { IPAssignment, SubnetInfo } from '@/types/proxmox';
import { analyzeSubnets } from '@/lib/utils/ip-utils';

interface IPOverviewProps {
  stats: ProxmoxStatsFromDB[];
}

export default function IPOverview({ stats }: IPOverviewProps) {
  const { assignments, subnets } = useMemo(() => {
    const assignments: IPAssignment[] = [];

    for (const stat of stats) {
      if (stat.entityType === 'node') continue;
      for (const ip of stat.ipAddresses) {
        assignments.push({
          ip,
          entity: stat.id,
          name: stat.name,
          type: stat.entityType as 'qemu' | 'lxc',
          vmid: stat.vmid ?? 0,
          node: stat.node,
        });
      }
    }

    const subnets = analyzeSubnets(assignments);
    return { assignments, subnets };
  }, [stats]);

  if (assignments.length === 0) {
    return (
      <Box className="mt-6">
        <Typography level="h4" className="mb-3 flex items-center gap-2">
          <Globe size={20} />
          IP Address Overview
        </Typography>
        <Typography level="body-sm" color="neutral">
          No IP addresses detected. IP detection requires:
          LXC containers with static IPs configured, or QEMU VMs with the guest agent installed.
        </Typography>
      </Box>
    );
  }

  return (
    <Box className="mt-6">
      <Typography level="h4" className="mb-3 flex items-center gap-2">
        <Globe size={20} />
        IP Address Overview
      </Typography>

      {subnets.map(subnet => (
        <SubnetCard key={subnet.cidr} subnet={subnet} />
      ))}
    </Box>
  );
}

function SubnetCard({ subnet }: { subnet: SubnetInfo }) {
  return (
    <Sheet variant="outlined" className="rounded-sm overflow-hidden mb-4">
      <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-700 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Typography level="title-md" className="font-mono">{subnet.cidr}</Typography>
          <Chip size="sm" variant="soft" color="primary">
            {subnet.usedCount} / {subnet.totalHosts} used
          </Chip>
        </div>
        {subnet.nextAvailable && (
          <div className="flex items-center gap-2">
            <Typography level="body-sm" color="neutral">Next available:</Typography>
            <Chip size="sm" variant="outlined" color="success" className="font-mono">
              {subnet.nextAvailable}
            </Chip>
          </div>
        )}
      </div>

      <div className="grid grid-cols-[1fr_1fr_80px_80px_1fr] min-w-[600px]">
        <div className="px-3 py-1.5 font-semibold text-xs border-b border-neutral-200 dark:border-neutral-700">IP Address</div>
        <div className="px-3 py-1.5 font-semibold text-xs border-b border-neutral-200 dark:border-neutral-700">Name</div>
        <div className="px-3 py-1.5 font-semibold text-xs border-b border-neutral-200 dark:border-neutral-700">Type</div>
        <div className="px-3 py-1.5 font-semibold text-xs border-b border-neutral-200 dark:border-neutral-700">VMID</div>
        <div className="px-3 py-1.5 font-semibold text-xs border-b border-neutral-200 dark:border-neutral-700">Node</div>

        {subnet.usedIPs.map(assignment => (
          <IPRow key={`${assignment.ip}-${assignment.entity}`} assignment={assignment} />
        ))}
      </div>
    </Sheet>
  );
}

function IPRow({ assignment }: { assignment: IPAssignment }) {
  return (
    <>
      <div className="px-3 py-1.5 text-sm font-mono tabular-nums">{assignment.ip}</div>
      <div className="px-3 py-1.5 text-sm truncate">{assignment.name}</div>
      <div className="px-3 py-1.5">
        <Chip size="sm" variant="soft" color={assignment.type === 'lxc' ? 'success' : 'warning'}>
          {assignment.type === 'lxc' ? 'LXC' : 'VM'}
        </Chip>
      </div>
      <div className="px-3 py-1.5 text-sm tabular-nums">{assignment.vmid}</div>
      <div className="px-3 py-1.5 text-sm">{assignment.node}</div>
    </>
  );
}
