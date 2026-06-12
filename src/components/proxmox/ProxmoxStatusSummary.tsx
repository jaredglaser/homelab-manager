import type { ProxmoxClusterOverview } from '@/types/proxmox';

interface ProxmoxStatusSummaryProps {
  overview: ProxmoxClusterOverview | null;
}

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

export default function ProxmoxStatusSummary({ overview }: Readonly<ProxmoxStatusSummaryProps>) {
  if (!overview) return null;

  const nodeCount = overview.nodes.length;
  const vmCount = overview.vms.length;
  const lxcCount = overview.containers.length;

  const segments: Segment[] = [];

  if (nodeCount > 0) segments.push({ label: 'nodes', count: nodeCount });
  if (vmCount > 0) segments.push({ label: 'VMs', count: vmCount });
  if (lxcCount > 0) segments.push({ label: 'LXCs', count: lxcCount });

  if (segments.length === 0) return null;

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
