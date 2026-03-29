import { useRef, useMemo } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { Box, CircularProgress, Paper, Typography } from '@mui/material';
import type { StackStatusEntry, StackSummary } from '@/types/stacks';
import StackRow from '@/components/stacks/StackRow';
import { useStackExpansion } from '@/hooks/useStackExpansion';

export const STACKS_GRID = 'grid grid-cols-[minmax(250px,2fr)_minmax(120px,1fr)_minmax(100px,1fr)_minmax(100px,1fr)_minmax(100px,1fr)] min-w-[600px]';

const ROW_HEIGHT_ESTIMATE = 48;
const EXPANDED_ROW_HEIGHT_ESTIMATE = 600;
const OVERSCAN = 5;

interface StacksTableProps {
  stacks: StackSummary[];
  isLoading: boolean;
  error: Error | null;
  statusMap: Map<string, StackStatusEntry>;
}

export default function StacksTable({ stacks, isLoading, error, statusMap }: Readonly<StacksTableProps>) {
  const { isStackExpanded, toggleStackExpanded } = useStackExpansion();

  const sortedStacks = useMemo(
    () => [...stacks].sort((a, b) => a.name.localeCompare(b.name) || a.host.localeCompare(b.host)),
    [stacks],
  );

  const groupHeights = useMemo(
    () => sortedStacks.map((s) => isStackExpanded(`${s.host}/${s.name}`) ? EXPANDED_ROW_HEIGHT_ESTIMATE : ROW_HEIGHT_ESTIMATE),
    [sortedStacks, isStackExpanded],
  );

  const listRef = useRef<HTMLDivElement>(null);

  const virtualizer = useWindowVirtualizer({
    count: sortedStacks.length,
    estimateSize: (index: number) => groupHeights[index],
    overscan: OVERSCAN,
    scrollMargin: listRef.current?.offsetTop ?? 0,
    getItemKey: (index: number) => `stack-${sortedStacks[index].host}/${sortedStacks[index].name}`,
  });

  const items = virtualizer.getVirtualItems();

  if (error && stacks.length === 0) {
    return (
      <Box className="w-full">
        <Box className="p-2">
          <Typography color="error">
            Error loading stacks: {error.message}
          </Typography>
        </Box>
      </Box>
    );
  }

  if (isLoading && stacks.length === 0) {
    return (
      <Box className="w-full">
        <Box className="flex justify-center p-4">
          <CircularProgress />
        </Box>
      </Box>
    );
  }

  if (stacks.length === 0) {
    return (
      <Box className="w-full">
        <Paper variant="outlined" className="rounded-sm p-8 text-center">
          <Typography variant="body1" className="opacity-70">
            No stacks found. Create a stack by adding a docker-compose.yml to the repository.
          </Typography>
        </Paper>
      </Box>
    );
  }

  return (
    <Box className="w-full">
      <Paper variant="outlined" className="rounded-sm overflow-x-auto">
        <div className="min-w-[600px]">
          {/* Column headers */}
          <div className={`${STACKS_GRID} border-b border-neutral-200 dark:border-neutral-700`}>
            <div className="px-3 py-2 font-semibold text-sm whitespace-nowrap">Stack</div>
            <div className="px-3 py-2 font-semibold text-sm whitespace-nowrap">Host</div>
            <div className="px-3 py-2 font-semibold text-sm whitespace-nowrap">Status</div>
            <div className="px-3 py-2 font-semibold text-sm whitespace-nowrap">Mode</div>
            <div className="px-3 py-2 font-semibold text-sm whitespace-nowrap">Last Deploy</div>
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
                  const stack = sortedStacks[virtualRow.index];
                  return (
                    <div
                      key={virtualRow.key}
                      data-index={virtualRow.index}
                      ref={virtualizer.measureElement}
                    >
                      <StackRow
                        stack={stack}
                        expanded={isStackExpanded(`${stack.host}/${stack.name}`)}
                        onToggle={() => toggleStackExpanded(`${stack.host}/${stack.name}`)}
                        statusMap={statusMap}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </Paper>
    </Box>
  );
}
