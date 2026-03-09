import { memo, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAtomValue } from 'jotai';
import { Box, Chip, CircularProgress, Collapse, Paper, Button, Typography } from '@mui/material';
import { ChevronRight, Layers, Package, RotateCw } from 'lucide-react';
import { MetricValue, MetricHeader } from '@/components/shared-table';
import { StaleDataAlert } from '@/components/shared-table/StaleDataAlert';
import UpdateDialog from '@/components/docker/UpdateDialog';
import { formatAsPercentParts, formatBytesParts, formatBitsSIUnitsParts } from '@/formatters/metrics';
import { useSettings } from '@/hooks/useSettings';
import { rawSettingsAtom } from '@/hooks/settingsAtom';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';
import { getPortainerStacks } from '@/data/portainer.functions';
import type { DockerStatsRow } from '@/types/docker';

const STACKS_GRID = 'grid grid-cols-[minmax(200px,15%)_minmax(80px,8%)_repeat(4,minmax(0,1fr))_auto] min-w-[600px]';
const CONTAINER_GRID = 'grid grid-cols-[minmax(200px,15%)_minmax(80px,8%)_repeat(4,minmax(0,1fr))_auto] min-w-[600px]';

interface StacksTableProps {
  latestByEntity: Map<string, DockerStatsRow>;
  rows: DockerStatsRow[];
  hasData: boolean;
  isConnected: boolean;
  error: Error | null;
  isStale: boolean;
  versionsWithUpdates?: Set<string>;
  onOpenInfo?: (containerId: string, host: string, image: string, name: string, serviceKeyEntity: string) => void;
}

interface StackGroup {
  stackId: number;
  stackName: string;
  endpointId: number;
  endpointName: string;
  status: number;
  containers: DockerStatsRow[];
  aggregated: {
    cpuPercent: number;
    memoryUsage: number;
    memoryLimit: number;
    memoryPercent: number;
    networkRxBytesPerSec: number;
    networkTxBytesPerSec: number;
  };
  updateCount: number;
}

interface OrphanGroup {
  containers: DockerStatsRow[];
}

export default function StacksTable({
  latestByEntity,
  hasData,
  isConnected,
  error,
  isStale,
  versionsWithUpdates,
  onOpenInfo,
}: StacksTableProps) {
  const { docker, general } = useSettings();
  const [expandedStacks, setExpandedStacks] = useState<Set<string>>(new Set());
  const [redeployTarget, setRedeployTarget] = useState<{
    stackId: number;
    stackName: string;
    endpointId: number;
  } | null>(null);

  const rawSettings = useAtomValue(rawSettingsAtom);
  const updateInProgress = rawSettings[SETTINGS_KEYS.update.status] !== undefined
    && rawSettings[SETTINGS_KEYS.update.status] !== ''
    && rawSettings[SETTINGS_KEYS.update.status] !== 'idle';

  const { data: portainerStacks, isLoading: stacksLoading } = useQuery({
    queryKey: ['portainer-stacks'],
    queryFn: () => getPortainerStacks(),
    staleTime: 60_000,
  });

  const toggleStack = (stackName: string) => {
    setExpandedStacks((prev) => {
      const next = new Set(prev);
      if (next.has(stackName)) {
        next.delete(stackName);
      } else {
        next.add(stackName);
      }
      return next;
    });
  };

  const { stackGroups, orphanGroup } = useMemo(() => {
    const containers = Array.from(latestByEntity.values());
    const stacks = portainerStacks ?? [];

    // Sort stacks by name for stable ordering
    const sortedStacks = [...stacks].sort((a, b) => a.name.localeCompare(b.name));

    const matched = new Set<string>();
    const groups: StackGroup[] = [];

    for (const stack of sortedStacks) {
      const stackNameLower = stack.name.toLowerCase();
      const stackContainers: DockerStatsRow[] = [];

      for (const row of containers) {
        const entityKey = `${row.host}/${row.container_id}`;
        if (matched.has(entityKey)) continue;

        const name = (row.container_name ?? row.container_id).toLowerCase();
        // Match containers whose name starts with the stack name followed by a separator
        if (name.startsWith(stackNameLower + '-') || name.startsWith(stackNameLower + '_') || name === stackNameLower) {
          stackContainers.push(row);
          matched.add(entityKey);
        }
      }

      if (stackContainers.length === 0) continue;

      // Sort containers within stack for stable order
      stackContainers.sort((a, b) =>
        (a.container_name ?? a.container_id).localeCompare(b.container_name ?? b.container_id),
      );

      // Aggregate metrics
      let cpuPercent = 0;
      let memoryUsage = 0;
      let memoryLimit = 0;
      let networkRxBytesPerSec = 0;
      let networkTxBytesPerSec = 0;
      let updateCount = 0;

      for (const row of stackContainers) {
        cpuPercent += Number(row.cpu_percent ?? 0);
        memoryUsage += Number(row.memory_usage ?? 0);
        memoryLimit += Number(row.memory_limit ?? 0);
        networkRxBytesPerSec += Number(row.network_rx_bytes_per_sec ?? 0);
        networkTxBytesPerSec += Number(row.network_tx_bytes_per_sec ?? 0);
        if (row.image && versionsWithUpdates?.has(row.image)) {
          updateCount++;
        }
      }

      const memoryPercent = memoryLimit > 0 ? (memoryUsage / memoryLimit) * 100 : 0;

      groups.push({
        stackId: stack.id,
        stackName: stack.name,
        endpointId: stack.endpointId,
        endpointName: stack.endpointName,
        status: stack.status,
        containers: stackContainers,
        aggregated: {
          cpuPercent,
          memoryUsage,
          memoryLimit,
          memoryPercent,
          networkRxBytesPerSec,
          networkTxBytesPerSec,
        },
        updateCount,
      });
    }

    // Orphan containers that didn't match any stack
    const orphanContainers = containers
      .filter((row) => !matched.has(`${row.host}/${row.container_id}`))
      .sort((a, b) =>
        (a.container_name ?? a.container_id).localeCompare(b.container_name ?? b.container_id),
      );

    const orphan: OrphanGroup | null = orphanContainers.length > 0
      ? { containers: orphanContainers }
      : null;

    return { stackGroups: groups, orphanGroup: orphan };
  }, [latestByEntity, portainerStacks, versionsWithUpdates]);

  const memLabel = docker.memoryDisplayMode === 'percentage' ? 'RAM %' : 'RAM';

  // Loading / error states
  if (error && !hasData) {
    return (
      <Box className="w-full">
        <Box className="p-2">
          <Typography color="error">
            Error connecting to Docker stats: {error.message}
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

  if (stacksLoading) {
    return (
      <Box className="w-full">
        <Box className="flex justify-center p-4">
          <CircularProgress />
        </Box>
      </Box>
    );
  }

  if (stackGroups.length === 0 && !orphanGroup) {
    return (
      <Box className="w-full text-center py-12 text-[var(--mui-palette-text-secondary)]">
        No stacks found. Ensure Portainer is configured and containers are running.
      </Box>
    );
  }

  return (
    <Box className="w-full">
      <StaleDataAlert isStale={isStale} />
      <Paper variant="outlined" className="rounded-sm overflow-x-auto">
        <div className="min-w-[600px]">
          {/* Column headers */}
          <div className={`${STACKS_GRID} border-b border-neutral-200 dark:border-neutral-700`}>
            <div className="px-3 py-2 font-semibold text-sm whitespace-nowrap">Stack</div>
            <div className="px-3 py-2 font-semibold text-sm whitespace-nowrap">Status</div>
            <div className="py-2"><MetricHeader>CPU</MetricHeader></div>
            <div className="py-2"><MetricHeader>{memLabel}</MetricHeader></div>
            <div className="py-2"><MetricHeader>Net RX</MetricHeader></div>
            <div className="py-2"><MetricHeader>Net TX</MetricHeader></div>
            <div className="px-3 py-2 font-semibold text-sm whitespace-nowrap">Actions</div>
          </div>

          {/* Stack rows */}
          {stackGroups.map((stack) => {
            const expanded = expandedStacks.has(stack.stackName);
            return (
              <div key={`${stack.stackId}-${stack.stackName}`}>
                <StackRow
                  stack={stack}
                  expanded={expanded}
                  onToggle={() => toggleStack(stack.stackName)}
                  decimals={docker.decimals}
                  memoryDisplayMode={docker.memoryDisplayMode}
                  showSparklines={general.showSparklines}
                  useAbbreviatedUnits={general.useAbbreviatedUnits}
                  updateInProgress={updateInProgress}
                  onRedeploy={() => setRedeployTarget({ stackId: stack.stackId, stackName: stack.stackName, endpointId: stack.endpointId })}
                />
                <Collapse in={expanded} unmountOnExit>
                  {stack.containers.map((row) => (
                    <StackContainerRow
                      key={`${row.host}/${row.container_id}`}
                      row={row}
                      decimals={docker.decimals}
                      memoryDisplayMode={docker.memoryDisplayMode}
                      showSparklines={general.showSparklines}
                      useAbbreviatedUnits={general.useAbbreviatedUnits}
                      updateAvailable={!!(row.image && versionsWithUpdates?.has(row.image))}
                      onOpenInfo={onOpenInfo}
                    />
                  ))}
                </Collapse>
              </div>
            );
          })}

          {/* Orphan containers */}
          {orphanGroup && (
            <div>
              <div className={`${STACKS_GRID} items-center border-t border-neutral-200 dark:border-neutral-700 bg-[var(--mui-palette-background-level1)]`}>
                <div className="px-3 py-2 flex items-center gap-2">
                  <Package size={18} className="text-neutral-500" />
                  <span className="font-bold text-neutral-500">Unassigned</span>
                  <Chip size="small" variant="filled" label={`${orphanGroup.containers.length} container${orphanGroup.containers.length !== 1 ? 's' : ''}`} />
                </div>
                <div />
                <div />
                <div />
                <div />
                <div />
                <div />
              </div>
              {orphanGroup.containers.map((row) => (
                <StackContainerRow
                  key={`${row.host}/${row.container_id}`}
                  row={row}
                  decimals={docker.decimals}
                  memoryDisplayMode={docker.memoryDisplayMode}
                  showSparklines={general.showSparklines}
                  useAbbreviatedUnits={general.useAbbreviatedUnits}
                  updateAvailable={!!(row.image && versionsWithUpdates?.has(row.image))}
                  onOpenInfo={onOpenInfo}
                />
              ))}
            </div>
          )}
        </div>
      </Paper>
      {redeployTarget && (
        <UpdateDialog
          open={!!redeployTarget}
          onClose={() => setRedeployTarget(null)}
          mode="stack"
          stackId={redeployTarget.stackId}
          stackName={redeployTarget.stackName}
          endpointId={redeployTarget.endpointId}
        />
      )}
    </Box>
  );
}

// ─── Stack Row ────────────────────────────────────────────────────────────────

interface StackRowProps {
  stack: StackGroup;
  expanded: boolean;
  onToggle: () => void;
  decimals: { cpu: boolean; memory: boolean; diskSpeed: boolean; networkSpeed: boolean };
  memoryDisplayMode: string;
  showSparklines: boolean;
  useAbbreviatedUnits: boolean;
  updateInProgress: boolean;
  onRedeploy: () => void;
}

const StackRow = memo(function StackRow({
  stack,
  expanded,
  onToggle,
  decimals,
  memoryDisplayMode,
  showSparklines,
  useAbbreviatedUnits,
  updateInProgress,
  onRedeploy,
}: StackRowProps) {
  const a = stack.aggregated;
  const networkRxBps = a.networkRxBytesPerSec * 8;
  const networkTxBps = a.networkTxBytesPerSec * 8;

  const cpuParts = formatAsPercentParts(a.cpuPercent / 100, decimals.cpu);
  const memoryParts = memoryDisplayMode === 'bytes'
    ? formatBytesParts(a.memoryUsage, false, decimals.memory)
    : formatAsPercentParts(a.memoryPercent / 100, decimals.memory);
  const networkRxParts = formatBitsSIUnitsParts(networkRxBps, true, decimals.networkSpeed);
  const networkTxParts = formatBitsSIUnitsParts(networkTxBps, true, decimals.networkSpeed);

  const runningCount = stack.containers.length;

  return (
    <div
      onClick={onToggle}
      className={`${STACKS_GRID} items-center border-t border-neutral-200 dark:border-neutral-700 cursor-pointer transition-colors duration-150 ${
        expanded ? 'bg-[var(--mui-palette-action-hover)]' : 'bg-[var(--mui-palette-background-level1)]'
      }`}
    >
      <div className="px-3 py-2 flex items-center gap-2">
        <ChevronRight
          size={18}
          className={`transition-transform duration-200 flex-shrink-0 ${expanded ? 'rotate-90' : ''}`}
        />
        <Layers size={18} className="flex-shrink-0" />
        <span className="font-bold truncate">{stack.stackName}</span>
        {stack.updateCount > 0 && (
          <Chip size="small" color="info" variant="filled" label={`${stack.updateCount} update${stack.updateCount !== 1 ? 's' : ''}`} />
        )}
      </div>
      <div className="px-3">
        <Chip
          size="small"
          variant="filled"
          color={stack.status === 1 ? 'success' : 'default'}
          label={`${runningCount} running`}
        />
      </div>
      <div>
        <MetricValue value={cpuParts.value} unit={cpuParts.unit} hasDecimals={decimals.cpu} showSparklines={showSparklines} useAbbreviatedUnits={useAbbreviatedUnits} />
      </div>
      <div>
        <MetricValue value={memoryParts.value} unit={memoryParts.unit} hasDecimals={decimals.memory} showSparklines={showSparklines} useAbbreviatedUnits={useAbbreviatedUnits} />
      </div>
      <div>
        <MetricValue value={networkRxParts.value} unit={networkRxParts.unit} hasDecimals={decimals.networkSpeed} showSparklines={showSparklines} useAbbreviatedUnits={useAbbreviatedUnits} />
      </div>
      <div>
        <MetricValue value={networkTxParts.value} unit={networkTxParts.unit} hasDecimals={decimals.networkSpeed} showSparklines={showSparklines} useAbbreviatedUnits={useAbbreviatedUnits} />
      </div>
      <div className="px-3">
        <Button
          size="small"
          variant="outlined"
          disabled={updateInProgress}
          startIcon={<RotateCw size={14} />}
          onClick={(e) => {
            e.stopPropagation();
            onRedeploy();
          }}
          className="!text-xs !normal-case"
        >
          Redeploy
        </Button>
      </div>
    </div>
  );
});

// ─── Stack Container Row ──────────────────────────────────────────────────────

interface StackContainerRowProps {
  row: DockerStatsRow;
  decimals: { cpu: boolean; memory: boolean; diskSpeed: boolean; networkSpeed: boolean };
  memoryDisplayMode: string;
  showSparklines: boolean;
  useAbbreviatedUnits: boolean;
  updateAvailable: boolean;
  onOpenInfo?: (containerId: string, host: string, image: string, name: string, serviceKeyEntity: string) => void;
}

const StackContainerRow = memo(function StackContainerRow({
  row,
  decimals,
  memoryDisplayMode,
  showSparklines,
  useAbbreviatedUnits,
  updateAvailable,
  onOpenInfo,
}: StackContainerRowProps) {
  const cpuPercent = Number(row.cpu_percent ?? 0);
  const memoryUsage = Number(row.memory_usage ?? 0);
  const memoryPercent = Number(row.memory_percent ?? 0);
  const networkRxBps = Number(row.network_rx_bytes_per_sec ?? 0) * 8;
  const networkTxBps = Number(row.network_tx_bytes_per_sec ?? 0) * 8;

  const name = row.container_name ?? row.container_id.substring(0, 12);
  const serviceKeyEntity = `${row.host}/${name}`;

  const cpuParts = formatAsPercentParts(cpuPercent / 100, decimals.cpu);
  const memoryParts = memoryDisplayMode === 'bytes'
    ? formatBytesParts(memoryUsage, false, decimals.memory)
    : formatAsPercentParts(memoryPercent / 100, decimals.memory);
  const networkRxParts = formatBitsSIUnitsParts(networkRxBps, true, decimals.networkSpeed);
  const networkTxParts = formatBitsSIUnitsParts(networkTxBps, true, decimals.networkSpeed);

  const handleClick = () => {
    if (onOpenInfo) {
      onOpenInfo(row.container_id, row.host, row.image ?? '', name, serviceKeyEntity);
    }
  };

  return (
    <div
      onClick={handleClick}
      className={`${CONTAINER_GRID} items-center border-t border-neutral-200/50 dark:border-neutral-700/50 transition-colors duration-150 ${
        onOpenInfo ? 'cursor-pointer hover:bg-[var(--mui-palette-action-hover)]' : ''
      }`}
    >
      <div className="px-3 py-1.5 pl-10 flex items-center gap-2">
        <Package size={14} className="flex-shrink-0 text-neutral-500" />
        <span className="text-sm truncate">{name}</span>
        {updateAvailable && (
          <Chip size="small" color="info" variant="outlined" label="update" className="!text-[10px] !h-5" />
        )}
      </div>
      <div />
      <div>
        <MetricValue value={cpuParts.value} unit={cpuParts.unit} hasDecimals={decimals.cpu} showSparklines={showSparklines} useAbbreviatedUnits={useAbbreviatedUnits} />
      </div>
      <div>
        <MetricValue value={memoryParts.value} unit={memoryParts.unit} hasDecimals={decimals.memory} showSparklines={showSparklines} useAbbreviatedUnits={useAbbreviatedUnits} />
      </div>
      <div>
        <MetricValue value={networkRxParts.value} unit={networkRxParts.unit} hasDecimals={decimals.networkSpeed} showSparklines={showSparklines} useAbbreviatedUnits={useAbbreviatedUnits} />
      </div>
      <div>
        <MetricValue value={networkTxParts.value} unit={networkTxParts.unit} hasDecimals={decimals.networkSpeed} showSparklines={showSparklines} useAbbreviatedUnits={useAbbreviatedUnits} />
      </div>
      <div className="px-3" />
    </div>
  );
});
