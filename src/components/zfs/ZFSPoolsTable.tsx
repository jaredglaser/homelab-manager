import { useMemo, useRef } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { Alert, Box, Chip, CircularProgress, Sheet, Tooltip, Typography } from '@mui/joy';
import { AlertTriangle, ChevronRight, Server } from 'lucide-react';
import type { PoolStats, VdevStats, ZFSHostHierarchy, ZFSHostStats, ZFSIOStatWithRates, ZFSStatsRow } from '@/types/zfs';
import { buildZFSHostHierarchy } from '@/lib/utils/zfs-hierarchy-builder';
import { formatBytes, formatAsPercent } from '@/formatters/metrics';
import { useSettings } from '@/hooks/useSettings';

type ZFSFlatRow =
  | { type: 'host'; host: ZFSHostStats; totalHosts: number }
  | { type: 'pool'; pool: PoolStats; totalPools: number; expandable: boolean; badge?: { label: string; tooltip?: string } }
  | { type: 'vdev'; vdev: VdevStats }
  | { type: 'disk'; disk: ZFSIOStatWithRates; indent: number };

const ROW_HEIGHT_ESTIMATE = 41;
const OVERSCAN = 10;

const ZFS_GRID = 'grid grid-cols-[30%_14%_11%_11%_11%_11%_12%] min-w-[800px]';

interface ZFSPoolsTableProps {
  latestByEntity: Map<string, ZFSStatsRow>;
  hasData: boolean;
  isConnected: boolean;
  error: Error | null;
  isStale: boolean;
}

export default function ZFSPoolsTable({
  latestByEntity,
  hasData,
  isConnected,
  error,
  isStale,
}: ZFSPoolsTableProps) {
  const { isZfsHostExpanded, isPoolExpanded, isVdevExpanded } = useSettings();

  // Build multi-host hierarchy from latest rows
  const hostHierarchy = useMemo<ZFSHostHierarchy>(() => {
    const rows = Array.from(latestByEntity.values());
    return buildZFSHostHierarchy(rows);
  }, [latestByEntity]);

  const flatRows = useMemo<ZFSFlatRow[]>(() => {
    const rows: ZFSFlatRow[] = [];
    const totalHosts = hostHierarchy.size;

    for (const hostStats of hostHierarchy.values()) {
      // Add host row if there are multiple hosts
      if (totalHosts > 1) {
        rows.push({ type: 'host', host: hostStats, totalHosts });

        if (!isZfsHostExpanded(hostStats.hostName, totalHosts)) {
          continue;
        }
      }

      const poolHierarchy = hostStats.pools;
      const totalPools = poolHierarchy.size;

      for (const pool of poolHierarchy.values()) {
        const vdevs = Array.from(pool.vdevs.values());
        const disks = Array.from(pool.individualDisks.values());
        const singleVdev = vdevs.length === 1 && disks.length === 0;
        const isSingleDiskPool =
          (singleVdev && vdevs[0].disks.size <= 1) ||
          (vdevs.length === 0 && disks.length === 1);
        const isSingleVdevMultiDisk = singleVdev && vdevs[0].disks.size > 1;

        let badge: { label: string; tooltip?: string } | undefined;
        if (isSingleDiskPool) {
          const tooltipName = singleVdev
            ? Array.from(vdevs[0].disks.values())[0]?.data.name ?? vdevs[0].data.name
            : disks[0]?.data.name;
          badge = { label: 'single disk', tooltip: tooltipName };
        } else if (singleVdev) {
          badge = { label: vdevs[0].data.name };
        }

        const expandable = !isSingleDiskPool;
        rows.push({ type: 'pool', pool, totalPools, expandable, badge });

        if (!expandable) continue;

        const expanded = isPoolExpanded(pool.data.name, totalPools);
        if (!expanded) continue;

        if (isSingleVdevMultiDisk) {
          for (const disk of vdevs[0].disks.values()) {
            rows.push({ type: 'disk', disk: disk.data, indent: 1 });
          }
        } else {
          for (const vdev of vdevs) {
            rows.push({ type: 'vdev', vdev });
            if (isVdevExpanded(vdev.data.id) && vdev.disks.size > 0) {
              for (const disk of vdev.disks.values()) {
                rows.push({ type: 'disk', disk: disk.data, indent: 2 });
              }
            }
          }
          for (const disk of disks) {
            rows.push({ type: 'disk', disk: disk.data, indent: 1 });
          }
        }
      }
    }

    return rows;
  }, [hostHierarchy, isZfsHostExpanded, isPoolExpanded, isVdevExpanded]);

  const listRef = useRef<HTMLDivElement>(null);

  const virtualizer = useWindowVirtualizer({
    count: flatRows.length,
    estimateSize: () => ROW_HEIGHT_ESTIMATE,
    overscan: OVERSCAN,
    scrollMargin: listRef.current?.offsetTop ?? 0,
    getItemKey: (index: number) => {
      const row = flatRows[index];
      if (row.type === 'host') return `host-${row.host.hostName}`;
      if (row.type === 'pool') return `pool-${row.pool.data.id}`;
      if (row.type === 'vdev') return `vdev-${row.vdev.data.id}`;
      return `disk-${row.disk.id}`;
    },
  });

  const items = virtualizer.getVirtualItems();

  if (error && !hasData) {
    return (
      <Box className="w-full">
        <Box className="p-2">
          <Typography color="danger">
            Error connecting to ZFS stats: {error.message}
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
        <div className={`${ZFS_GRID} border-b border-neutral-200 dark:border-neutral-700`}>
          <div className="px-3 py-2 font-semibold text-sm whitespace-nowrap">
            {hostHierarchy.size > 1 ? 'Host / Pool / Device' : 'Pool / Device'}
          </div>
          <div className="px-3 py-2 font-semibold text-sm text-right whitespace-nowrap">Capacity</div>
          <div className="px-3 py-2 font-semibold text-sm text-right whitespace-nowrap">Read Ops/s</div>
          <div className="px-3 py-2 font-semibold text-sm text-right whitespace-nowrap">Write Ops/s</div>
          <div className="px-3 py-2 font-semibold text-sm text-right whitespace-nowrap">Read</div>
          <div className="px-3 py-2 font-semibold text-sm text-right whitespace-nowrap">Write</div>
          <div className="px-3 py-2 font-semibold text-sm text-right whitespace-nowrap">Utilization</div>
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
                    {row.type === 'host' ? (
                      <HostRow host={row.host} totalHosts={row.totalHosts} />
                    ) : row.type === 'pool' ? (
                      <PoolRow
                        pool={row.pool}
                        totalPools={row.totalPools}
                        expandable={row.expandable}
                        badge={row.badge}
                      />
                    ) : row.type === 'vdev' ? (
                      <VdevRow vdev={row.vdev} />
                    ) : (
                      <DiskRow disk={row.disk} indent={row.indent} />
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

// ─── Metric Cells ───────────────────────────────────────────────────────────────

function ZFSMetrics({ data, showCapacity = true }: { data: ZFSIOStatWithRates; showCapacity?: boolean }) {
  const { zfs } = useSettings();
  const { decimals } = zfs;

  return (
    <>
      <div className="px-3 py-2 text-right tabular-nums text-sm">
        {showCapacity && data.capacity.alloc > 0
          ? formatBytes(data.capacity.alloc, false)
          : '\u2014'}
      </div>
      <div className="px-3 py-2 text-right tabular-nums text-sm">
        {data.rates.readOpsPerSec.toFixed(0)}
      </div>
      <div className="px-3 py-2 text-right tabular-nums text-sm">
        {data.rates.writeOpsPerSec.toFixed(0)}
      </div>
      <div className="px-3 py-2 text-right tabular-nums text-sm">
        {formatBytes(data.rates.readBytesPerSec, true, decimals.diskSpeed)}
      </div>
      <div className="px-3 py-2 text-right tabular-nums text-sm">
        {formatBytes(data.rates.writeBytesPerSec, true, decimals.diskSpeed)}
      </div>
      <div className="px-3 py-2 text-right tabular-nums text-sm">
        {formatAsPercent(data.rates.utilizationPercent / 100, decimals.diskSpeed)}
      </div>
    </>
  );
}

function HostAggregateMetrics({ host }: { host: ZFSHostStats }) {
  const { zfs } = useSettings();
  const { decimals } = zfs;
  const a = host.aggregated;

  return (
    <>
      <div className="px-3 py-2 text-right tabular-nums text-sm">
        {a.capacityAlloc > 0 ? formatBytes(a.capacityAlloc, false) : '\u2014'}
      </div>
      <div className="px-3 py-2 text-right tabular-nums text-sm">
        {a.readOpsPerSec.toFixed(0)}
      </div>
      <div className="px-3 py-2 text-right tabular-nums text-sm">
        {a.writeOpsPerSec.toFixed(0)}
      </div>
      <div className="px-3 py-2 text-right tabular-nums text-sm">
        {formatBytes(a.readBytesPerSec, true, decimals.diskSpeed)}
      </div>
      <div className="px-3 py-2 text-right tabular-nums text-sm">
        {formatBytes(a.writeBytesPerSec, true, decimals.diskSpeed)}
      </div>
      <div className="px-3 py-2 text-right tabular-nums text-sm">
        {'\u2014'}
      </div>
    </>
  );
}

// ─── Host Row ───────────────────────────────────────────────────────────────────

function HostRow({ host, totalHosts }: { host: ZFSHostStats; totalHosts: number }) {
  const { isZfsHostExpanded, toggleZfsHostExpanded } = useSettings();
  const expanded = isZfsHostExpanded(host.hostName, totalHosts);
  const hasPools = host.pools.size > 0;

  const handleClick = () => {
    if (hasPools && totalHosts > 1) {
      toggleZfsHostExpanded(host.hostName);
    }
  };

  return (
    <div
      onClick={handleClick}
      className={`${ZFS_GRID} items-center ${
        hasPools && totalHosts > 1 ? 'cursor-pointer' : 'cursor-default'
      }`}
    >
      <div className="px-3 py-2 flex items-center gap-2">
        {hasPools && totalHosts > 1 && (
          <ChevronRight
            size={18}
            className={`flex-shrink-0 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          />
        )}
        <Server size={18} />
        <span className="font-bold">{host.hostName}</span>
        <Chip size="sm" variant="soft">
          {host.aggregated.poolCount} pool{host.aggregated.poolCount !== 1 ? 's' : ''}
        </Chip>
      </div>
      <HostAggregateMetrics host={host} />
    </div>
  );
}

// ─── Pool Row ───────────────────────────────────────────────────────────────────

function PoolRow({
  pool,
  totalPools,
  expandable,
  badge,
}: {
  pool: PoolStats;
  totalPools: number;
  expandable: boolean;
  badge?: { label: string; tooltip?: string };
}) {
  const { isPoolExpanded, togglePoolExpanded } = useSettings();
  const expanded = isPoolExpanded(pool.data.name, totalPools);
  const canToggle = expandable && totalPools > 1;

  const handleClick = () => {
    if (canToggle) {
      togglePoolExpanded(pool.data.name);
    }
  };

  const chipEl = badge ? (
    <Chip size="sm" variant="soft">{badge.label}</Chip>
  ) : null;

  return (
    <div
      onClick={handleClick}
      className={`${ZFS_GRID} items-center ${canToggle ? 'cursor-pointer' : 'cursor-default'}`}
    >
      <div className="px-3 py-2 flex items-center gap-2 overflow-hidden">
        {canToggle && (
          <ChevronRight
            size={18}
            className={`flex-shrink-0 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          />
        )}
        <span className="font-bold truncate">{pool.data.name}</span>
        {badge?.tooltip ? (
          <Tooltip title={badge.tooltip} arrow placement="bottom-end">
            {chipEl!}
          </Tooltip>
        ) : chipEl}
      </div>
      <ZFSMetrics data={pool.data} />
    </div>
  );
}

// ─── Vdev Row ───────────────────────────────────────────────────────────────────

function VdevRow({ vdev }: { vdev: VdevStats }) {
  const { isVdevExpanded, toggleVdevExpanded } = useSettings();
  const hasDisks = vdev.disks.size > 0;
  const expanded = isVdevExpanded(vdev.data.id);

  const handleClick = () => {
    if (hasDisks) {
      toggleVdevExpanded(vdev.data.id);
    }
  };

  return (
    <div
      onClick={handleClick}
      className={`${ZFS_GRID} items-center bg-[var(--joy-palette-background-level2)] ${hasDisks ? 'cursor-pointer' : 'cursor-default'}`}
    >
      <div className="py-2 pr-3 flex items-center gap-2 overflow-hidden" style={{ paddingLeft: '2rem' }}>
        {hasDisks && (
          <ChevronRight
            size={16}
            className={`flex-shrink-0 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          />
        )}
        <span className="text-sm truncate">{vdev.data.name}</span>
      </div>
      <ZFSMetrics data={vdev.data} showCapacity={vdev.data.capacity.alloc > 0} />
    </div>
  );
}

// ─── Disk Row ───────────────────────────────────────────────────────────────────

function DiskRow({ disk, indent }: { disk: ZFSIOStatWithRates; indent: number }) {
  return (
    <div
      className={`${ZFS_GRID} items-center bg-[var(--joy-palette-background-level1)]`}
    >
      <div className="py-2 pr-3 overflow-hidden" style={{ paddingLeft: `${indent * 2}rem` }}>
        <span className="text-xs font-mono truncate">{disk.name}</span>
      </div>
      <ZFSMetrics data={disk} showCapacity={false} />
    </div>
  );
}
