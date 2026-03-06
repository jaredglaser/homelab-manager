import { useMemo, useRef } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { Box, Chip, CircularProgress, Collapse, Paper, Tooltip, Typography } from '@mui/material';
import { ChevronRight, Server } from 'lucide-react';
import { StaleDataAlert } from '@/components/shared-table/StaleDataAlert';
import type { PoolStats, VdevStats, ZFSHostHierarchy, ZFSHostStats, ZFSIOStatWithRates, ZFSStatsRow } from '@/types/zfs';
import { buildZFSHostHierarchy } from '@/lib/utils/zfs-hierarchy-builder';
import { formatBytesParts, formatAsPercentParts } from '@/formatters/metrics';
import { MetricValue, MetricHeader, EMPTY_METRIC } from '@/components/shared-table';
import { useSettings } from '@/hooks/useSettings';

type ZFSFlatRow =
  | { type: 'host'; host: ZFSHostStats; totalHosts: number }
  | { type: 'pool'; pool: PoolStats; totalPools: number; expandable: boolean; badge?: { label: string; tooltip?: string }; isSingleVdevMultiDisk: boolean };

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
  const { isZfsHostExpanded } = useSettings();

  // Build multi-host hierarchy from latest rows
  const hostHierarchy = useMemo<ZFSHostHierarchy>(() => {
    const rows = Array.from(latestByEntity.values());
    return buildZFSHostHierarchy(rows);
  }, [latestByEntity]);

  // Flatten to host + pool rows only; children render inside PoolRow via Collapse
  const flatRows = useMemo<ZFSFlatRow[]>(() => {
    const rows: ZFSFlatRow[] = [];
    const totalHosts = hostHierarchy.size;

    for (const hostStats of hostHierarchy.values()) {
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
        rows.push({ type: 'pool', pool, totalPools, expandable, badge, isSingleVdevMultiDisk });
      }
    }

    return rows;
  }, [hostHierarchy, isZfsHostExpanded]);

  const listRef = useRef<HTMLDivElement>(null);

  const virtualizer = useWindowVirtualizer({
    count: flatRows.length,
    estimateSize: () => ROW_HEIGHT_ESTIMATE,
    overscan: OVERSCAN,
    scrollMargin: listRef.current?.offsetTop ?? 0,
    getItemKey: (index: number) => {
      const row = flatRows[index];
      if (row.type === 'host') return `host-${row.host.hostName}`;
      return `pool-${row.pool.data.id}`;
    },
  });

  const items = virtualizer.getVirtualItems();

  if (error && !hasData) {
    return (
      <Box className="w-full">
        <Box className="p-2">
          <Typography color="error">
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
      <StaleDataAlert isStale={isStale} />
      <Paper variant="outlined" className="rounded-sm overflow-x-auto">
        {/* Column headers */}
        <div className={`${ZFS_GRID} border-b border-neutral-200 dark:border-neutral-700`}>
          <div className="px-3 py-2 font-semibold text-sm whitespace-nowrap">
            {hostHierarchy.size > 1 ? 'Host / Pool / Device' : 'Pool / Device'}
          </div>
          <div className="px-3 py-2"><MetricHeader>Capacity</MetricHeader></div>
          <div className="px-3 py-2"><MetricHeader>Read Ops/s</MetricHeader></div>
          <div className="px-3 py-2"><MetricHeader>Write Ops/s</MetricHeader></div>
          <div className="px-3 py-2"><MetricHeader>Read</MetricHeader></div>
          <div className="px-3 py-2"><MetricHeader>Write</MetricHeader></div>
          <div className="px-3 py-2"><MetricHeader>Utilization</MetricHeader></div>
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
                    ) : (
                      <PoolRow
                        pool={row.pool}
                        totalPools={row.totalPools}
                        expandable={row.expandable}
                        badge={row.badge}
                        isSingleVdevMultiDisk={row.isSingleVdevMultiDisk}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </Paper>
    </Box>
  );
}

// ─── Metric Cells ───────────────────────────────────────────────────────────────

function ZFSMetrics({ data, showCapacity = true }: { data: ZFSIOStatWithRates; showCapacity?: boolean }) {
  const { zfs } = useSettings();
  const { decimals } = zfs;

  const totalBytes = data.capacity.alloc + data.capacity.free;
  const capacityParts = showCapacity && totalBytes > 0
    ? formatBytesParts(totalBytes, false)
    : null;
  const readOpsParts = { value: data.rates.readOpsPerSec.toFixed(0), unit: 'ops/s' };
  const writeOpsParts = { value: data.rates.writeOpsPerSec.toFixed(0), unit: 'ops/s' };
  const readParts = formatBytesParts(data.rates.readBytesPerSec, true, decimals.diskSpeed);
  const writeParts = formatBytesParts(data.rates.writeBytesPerSec, true, decimals.diskSpeed);
  const utilParts = formatAsPercentParts(data.rates.utilizationPercent / 100, decimals.diskSpeed);

  return (
    <>
      <div className="px-3 py-2">
        {capacityParts
          ? <MetricValue value={capacityParts.value} unit={capacityParts.unit} />
          : <MetricValue value={EMPTY_METRIC} unit="" />}
      </div>
      <div className="px-3 py-2">
        <MetricValue value={readOpsParts.value} unit={readOpsParts.unit} />
      </div>
      <div className="px-3 py-2">
        <MetricValue value={writeOpsParts.value} unit={writeOpsParts.unit} />
      </div>
      <div className="px-3 py-2">
        <MetricValue value={readParts.value} unit={readParts.unit} hasDecimals={decimals.diskSpeed} />
      </div>
      <div className="px-3 py-2">
        <MetricValue value={writeParts.value} unit={writeParts.unit} hasDecimals={decimals.diskSpeed} />
      </div>
      <div className="px-3 py-2">
        <MetricValue value={utilParts.value} unit={utilParts.unit} hasDecimals={decimals.diskSpeed} />
      </div>
    </>
  );
}

function HostAggregateMetrics({ host }: { host: ZFSHostStats }) {
  const { zfs } = useSettings();
  const { decimals } = zfs;
  const a = host.aggregated;

  const totalBytes = a.capacityAlloc + a.capacityFree;
  const capacityParts = totalBytes > 0 ? formatBytesParts(totalBytes, false) : null;
  const readOpsParts = { value: a.readOpsPerSec.toFixed(0), unit: 'ops/s' };
  const writeOpsParts = { value: a.writeOpsPerSec.toFixed(0), unit: 'ops/s' };
  const readParts = formatBytesParts(a.readBytesPerSec, true, decimals.diskSpeed);
  const writeParts = formatBytesParts(a.writeBytesPerSec, true, decimals.diskSpeed);

  return (
    <>
      <div className="px-3 py-2">
        {capacityParts
          ? <MetricValue value={capacityParts.value} unit={capacityParts.unit} />
          : <MetricValue value={EMPTY_METRIC} unit="" />}
      </div>
      <div className="px-3 py-2">
        <MetricValue value={readOpsParts.value} unit={readOpsParts.unit} />
      </div>
      <div className="px-3 py-2">
        <MetricValue value={writeOpsParts.value} unit={writeOpsParts.unit} />
      </div>
      <div className="px-3 py-2">
        <MetricValue value={readParts.value} unit={readParts.unit} hasDecimals={decimals.diskSpeed} />
      </div>
      <div className="px-3 py-2">
        <MetricValue value={writeParts.value} unit={writeParts.unit} hasDecimals={decimals.diskSpeed} />
      </div>
      <div className="px-3 py-2">
        <MetricValue value={EMPTY_METRIC} unit="" />
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
      className={`${ZFS_GRID} items-center bg-[var(--mui-palette-background-level1)] border-t border-neutral-200 dark:border-neutral-700 ${
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
        <Chip size="small" variant="filled" label={`${host.aggregated.poolCount} pool${host.aggregated.poolCount !== 1 ? 's' : ''}`} />
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
  isSingleVdevMultiDisk,
}: {
  pool: PoolStats;
  totalPools: number;
  expandable: boolean;
  badge?: { label: string; tooltip?: string };
  isSingleVdevMultiDisk: boolean;
}) {
  const { isPoolExpanded, togglePoolExpanded } = useSettings();
  const expanded = isPoolExpanded(pool.data.id, totalPools);
  const canToggle = expandable && totalPools > 1;

  const handleClick = () => {
    if (canToggle) {
      togglePoolExpanded(pool.data.id);
    }
  };

  const chipEl = badge ? (
    <Chip size="small" variant="filled" label={badge.label} />
  ) : null;

  const vdevs = Array.from(pool.vdevs.values());
  const individualDisks = Array.from(pool.individualDisks.values());

  return (
    <>
      <div
        onClick={handleClick}
        onKeyDown={canToggle ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(); } } : undefined}
        role={canToggle ? 'button' : undefined}
        tabIndex={canToggle ? 0 : undefined}
        aria-expanded={canToggle ? expanded : undefined}
        className={`${ZFS_GRID} items-center transition-colors duration-150 ${
          canToggle ? 'cursor-pointer' : 'cursor-default'
        } ${expanded ? 'bg-[var(--mui-palette-action-hover)]' : ''}`}
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

      {expandable && (
        <Collapse in={expanded} unmountOnExit>
          <div className="bg-[var(--mui-palette-action-hover)] border-b border-[var(--mui-palette-divider)]">
            {isSingleVdevMultiDisk ? (
              vdevs[0]?.disks && Array.from(vdevs[0].disks.values()).map((disk) => (
                <DiskRow key={disk.data.id} disk={disk.data} indent={1} />
              ))
            ) : (
              <>
                {vdevs.map((vdev) => (
                  <VdevRow key={vdev.data.id} vdev={vdev} />
                ))}
                {individualDisks.map((disk) => (
                  <DiskRow key={disk.data.id} disk={disk.data} indent={1} />
                ))}
              </>
            )}
          </div>
        </Collapse>
      )}
    </>
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
    <>
      <div
        onClick={handleClick}
        onKeyDown={hasDisks ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(); } } : undefined}
        role={hasDisks ? 'button' : undefined}
        tabIndex={hasDisks ? 0 : undefined}
        aria-expanded={hasDisks ? expanded : undefined}
        className={`${ZFS_GRID} items-center ${hasDisks ? 'cursor-pointer' : 'cursor-default'}`}
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

      {hasDisks && (
        <Collapse in={expanded} unmountOnExit>
          {Array.from(vdev.disks.values()).map((disk) => (
            <DiskRow key={disk.data.id} disk={disk.data} indent={2} />
          ))}
        </Collapse>
      )}
    </>
  );
}

// ─── Disk Row ───────────────────────────────────────────────────────────────────

function DiskRow({ disk, indent }: { disk: ZFSIOStatWithRates; indent: number }) {
  return (
    <div
      className={`${ZFS_GRID} items-center`}
    >
      <div className="py-2 pr-3 overflow-hidden" style={{ paddingLeft: `${indent * 2}rem` }}>
        <span className="text-sm truncate">{disk.name}</span>
      </div>
      <ZFSMetrics data={disk} showCapacity={false} />
    </div>
  );
}
