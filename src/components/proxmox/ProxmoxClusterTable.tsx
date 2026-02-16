import { useCallback, useMemo, useRef, useState } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { Alert, Box, Chip, CircularProgress, Sheet, Typography } from '@mui/joy';
import { AlertTriangle, ChevronRight, Monitor, Server } from 'lucide-react';
import type { ProxmoxStatsFromDB } from '@/lib/transformers/proxmox-transformer';
import type { ProxmoxHierarchy, ProxmoxNodeEntry } from '@/types/proxmox';
import { buildProxmoxHierarchy, aggregateNodeStats, formatUptime } from '@/lib/utils/proxmox-hierarchy-builder';
import { formatBytes } from '@/formatters/metrics';
import { useStreamingData } from '@/hooks/useStreamingData';

type ProxmoxFlatRow =
  | { type: 'node'; node: ProxmoxNodeEntry; totalNodes: number }
  | { type: 'guest'; guest: ProxmoxStatsFromDB };

const ROW_HEIGHT_ESTIMATE = 41;
const OVERSCAN = 10;
const PROXMOX_GRID = 'grid grid-cols-[24%_8%_10%_10%_10%_10%_10%_10%_8%] min-w-[900px]';

export default function ProxmoxClusterTable() {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

  const toggleNode = (nodeName: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(nodeName)) next.delete(nodeName);
      else next.add(nodeName);
      return next;
    });
  };

  const transform = useCallback(
    (raw: ProxmoxStatsFromDB[]) => buildProxmoxHierarchy(raw),
    [],
  );

  const { state: hierarchy, hasData, isConnected, error, isStale } = useStreamingData<
    ProxmoxStatsFromDB[],
    ProxmoxHierarchy
  >({
    url: '/api/proxmox-stats',
    transform,
    initialState: new Map(),
    staleKey: 'proxmox',
  });

  const flatRows = useMemo<ProxmoxFlatRow[]>(() => {
    const rows: ProxmoxFlatRow[] = [];
    const totalNodes = hierarchy.size;

    // Auto-expand if only one node
    const effectiveExpanded = totalNodes === 1
      ? new Set([...hierarchy.keys()])
      : expandedNodes;

    for (const node of hierarchy.values()) {
      rows.push({ type: 'node', node, totalNodes });

      if (effectiveExpanded.has(node.data.node)) {
        // Sort guests: running first, then by type (lxc before qemu), then by name
        const sortedGuests = Array.from(node.guests.values()).sort((a, b) => {
          const statusOrder = (s: string) => s === 'running' ? 0 : 1;
          const statusDiff = statusOrder(a.data.status) - statusOrder(b.data.status);
          if (statusDiff !== 0) return statusDiff;

          const typeDiff = a.data.entityType.localeCompare(b.data.entityType);
          if (typeDiff !== 0) return typeDiff;

          return a.data.name.localeCompare(b.data.name);
        });

        for (const guest of sortedGuests) {
          rows.push({ type: 'guest', guest: guest.data });
        }
      }
    }

    return rows;
  }, [hierarchy, expandedNodes]);

  const listRef = useRef<HTMLDivElement>(null);

  const virtualizer = useWindowVirtualizer({
    count: flatRows.length,
    estimateSize: () => ROW_HEIGHT_ESTIMATE,
    overscan: OVERSCAN,
    scrollMargin: listRef.current?.offsetTop ?? 0,
    getItemKey: (index: number) => {
      const row = flatRows[index];
      return row.type === 'node' ? `node-${row.node.data.node}` : `guest-${row.guest.id}`;
    },
  });

  const items = virtualizer.getVirtualItems();

  if (error && !hasData) {
    return (
      <Box className="w-full">
        <Box className="p-2">
          <Typography color="danger">
            Error connecting to Proxmox stats: {error.message}
          </Typography>
        </Box>
      </Box>
    );
  }

  if (!isConnected && !hasData) {
    return (
      <Box className="w-full">
        <Box className="flex justify-center p-4">
          <CircularProgress />
        </Box>
      </Box>
    );
  }

  if (hasData && hierarchy.size === 0) {
    return (
      <Box className="w-full">
        <Alert color="neutral" variant="soft" className="mb-3">
          No Proxmox data available. Check that the background worker is running and PROXMOX_HOST is configured.
        </Alert>
      </Box>
    );
  }

  return (
    <Box className="w-full">
      {isStale && (
        <Alert
          color="warning"
          variant="soft"
          startDecorator={<AlertTriangle size={18} />}
          className="mb-3"
        >
          Data is stale. Background worker may not be running.
        </Alert>
      )}
      <Sheet variant="outlined" className="rounded-sm overflow-hidden">
        {/* Column headers */}
        <div className={`${PROXMOX_GRID} border-b border-neutral-200 dark:border-neutral-700`}>
          <div className="px-3 py-2 font-semibold text-sm whitespace-nowrap">Name</div>
          <div className="px-3 py-2 font-semibold text-sm text-center whitespace-nowrap">Status</div>
          <div className="px-3 py-2 font-semibold text-sm text-right whitespace-nowrap">CPU %</div>
          <div className="px-3 py-2 font-semibold text-sm text-right whitespace-nowrap">RAM</div>
          <div className="px-3 py-2 font-semibold text-sm text-right whitespace-nowrap">Disk</div>
          <div className="px-3 py-2 font-semibold text-sm text-right whitespace-nowrap">Net In</div>
          <div className="px-3 py-2 font-semibold text-sm text-right whitespace-nowrap">Net Out</div>
          <div className="px-3 py-2 font-semibold text-sm text-right whitespace-nowrap">Disk I/O</div>
          <div className="px-3 py-2 font-semibold text-sm text-right whitespace-nowrap">Uptime</div>
        </div>

        {/* Virtualized body */}
        <div ref={listRef}>
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: '100%',
              position: 'relative',
              willChange: 'transform',
              contain: 'layout style',
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translate3d(0, ${(items[0]?.start ?? 0) - virtualizer.options.scrollMargin}px, 0)`,
              }}
            >
              {items.map((virtualRow) => {
                const row = flatRows[virtualRow.index];
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                  >
                    {row.type === 'node' ? (
                      <NodeRow
                        node={row.node}
                        totalNodes={row.totalNodes}
                        expanded={row.totalNodes === 1 || expandedNodes.has(row.node.data.node)}
                        onToggle={() => toggleNode(row.node.data.node)}
                      />
                    ) : (
                      <GuestRow guest={row.guest} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </Sheet>
    </Box>
  );
}

// ─── Node Row ───────────────────────────────────────────────────────────────────

function NodeRow({
  node,
  totalNodes,
  expanded,
  onToggle,
}: {
  node: ProxmoxNodeEntry;
  totalNodes: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const agg = aggregateNodeStats(node);
  const canToggle = totalNodes > 1;

  return (
    <div
      onClick={canToggle ? onToggle : undefined}
      className={`${PROXMOX_GRID} items-center ${canToggle ? 'cursor-pointer' : 'cursor-default'}`}
    >
      <div className="px-3 py-2 flex items-center gap-2 overflow-hidden">
        {canToggle && (
          <ChevronRight
            size={18}
            className={`flex-shrink-0 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          />
        )}
        <Server size={16} className="flex-shrink-0 text-blue-600" />
        <span className="font-bold truncate">{node.data.name}</span>
        <Chip size="sm" variant="soft" color="primary">
          {agg.runningCount}/{agg.guestCount}
        </Chip>
      </div>
      <div className="px-3 py-2 text-center">
        <StatusChip status={node.data.status} />
      </div>
      <div className="px-3 py-2 text-right tabular-nums text-sm">
        {agg.cpuPercent.toFixed(1)}%
      </div>
      <div className="px-3 py-2 text-right tabular-nums text-sm">
        {formatBytes(agg.memoryUsage, false)} / {formatBytes(agg.memoryLimit, false)}
      </div>
      <div className="px-3 py-2 text-right tabular-nums text-sm">
        {formatBytes(agg.diskUsage, false)} / {formatBytes(agg.diskLimit, false)}
      </div>
      <div className="px-3 py-2 text-right tabular-nums text-sm">
        {formatBytes(agg.networkInBytesPerSec, true)}
      </div>
      <div className="px-3 py-2 text-right tabular-nums text-sm">
        {formatBytes(agg.networkOutBytesPerSec, true)}
      </div>
      <div className="px-3 py-2 text-right tabular-nums text-sm">
        {formatBytes(agg.diskReadBytesPerSec + agg.diskWriteBytesPerSec, true)}
      </div>
      <div className="px-3 py-2 text-right tabular-nums text-sm">
        {formatUptime(agg.uptime)}
      </div>
    </div>
  );
}

// ─── Guest Row ──────────────────────────────────────────────────────────────────

function GuestRow({ guest }: { guest: ProxmoxStatsFromDB }) {
  const isRunning = guest.status === 'running';

  return (
    <div className={`${PROXMOX_GRID} items-center bg-[var(--joy-palette-background-level1)]`}>
      <div className="py-2 pr-3 flex items-center gap-2 overflow-hidden" style={{ paddingLeft: '2.5rem' }}>
        <Monitor size={14} className={`flex-shrink-0 ${isRunning ? 'text-green-600' : 'text-neutral-400'}`} />
        <span className="text-sm truncate">{guest.name}</span>
        <Chip size="sm" variant="soft" color={guest.entityType === 'lxc' ? 'success' : 'warning'}>
          {guest.entityType === 'lxc' ? 'LXC' : 'VM'}
        </Chip>
        {guest.vmid !== null && (
          <span className="text-xs text-neutral-500">{guest.vmid}</span>
        )}
        {guest.tags.length > 0 && guest.tags.map(tag => (
          <Chip key={tag} size="sm" variant="outlined">{tag}</Chip>
        ))}
      </div>
      <div className="px-3 py-2 text-center">
        <StatusChip status={guest.status} />
      </div>
      <div className="px-3 py-2 text-right tabular-nums text-sm">
        {isRunning ? `${guest.rates.cpuPercent.toFixed(1)}%` : '—'}
      </div>
      <div className="px-3 py-2 text-right tabular-nums text-sm">
        {isRunning
          ? `${formatBytes(guest.rates.memoryUsage, false)} / ${formatBytes(guest.rates.memoryLimit, false)}`
          : formatBytes(guest.rates.memoryLimit, false)
        }
      </div>
      <div className="px-3 py-2 text-right tabular-nums text-sm">
        {guest.rates.diskLimit > 0
          ? `${formatBytes(guest.rates.diskUsage, false)} / ${formatBytes(guest.rates.diskLimit, false)}`
          : '—'
        }
      </div>
      <div className="px-3 py-2 text-right tabular-nums text-sm">
        {isRunning ? formatBytes(guest.rates.networkInBytesPerSec, true) : '—'}
      </div>
      <div className="px-3 py-2 text-right tabular-nums text-sm">
        {isRunning ? formatBytes(guest.rates.networkOutBytesPerSec, true) : '—'}
      </div>
      <div className="px-3 py-2 text-right tabular-nums text-sm">
        {isRunning
          ? formatBytes(guest.rates.diskReadBytesPerSec + guest.rates.diskWriteBytesPerSec, true)
          : '—'
        }
      </div>
      <div className="px-3 py-2 text-right tabular-nums text-sm">
        {isRunning ? formatUptime(guest.rates.uptime) : '—'}
      </div>
    </div>
  );
}

// ─── Status Chip ────────────────────────────────────────────────────────────────

function StatusChip({ status }: { status: string }) {
  const color = status === 'running' || status === 'online'
    ? 'success'
    : status === 'stopped' || status === 'offline'
      ? 'danger'
      : 'neutral';

  return (
    <Chip size="sm" variant="soft" color={color}>
      {status}
    </Chip>
  );
}
