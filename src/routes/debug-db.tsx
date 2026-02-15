import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
import { Alert, Box, Button, CircularProgress, FormControl, FormLabel, Input, Option, Select, Sheet, Typography } from '@mui/joy'
import { Database, RefreshCw, Search } from 'lucide-react'
import AppShell from '../components/AppShell'
import PageHeader from '@/components/PageHeader'
import { useSettings } from '@/hooks/useSettings'
import { getDebugSummary, queryDebugStats } from '@/data/debug-db.functions'
import type { DebugStatRow } from '@/lib/database/repositories/stats-repository'

export const Route = createFileRoute('/debug-db')({
  ssr: false,
  component: DebugDbPage,
})

const TIME_RANGES = [
  { label: '1 minute', seconds: 60 },
  { label: '5 minutes', seconds: 300 },
  { label: '15 minutes', seconds: 900 },
  { label: '1 hour', seconds: 3600 },
  { label: '6 hours', seconds: 21600 },
  { label: '24 hours', seconds: 86400 },
] as const;

const ROW_LIMITS = [100, 250, 500, 1000, 2500, 5000] as const;

const ROW_HEIGHT_ESTIMATE = 36;
const OVERSCAN = 20;
const DEBUG_GRID = 'grid grid-cols-[180px_80px_160px_1fr_120px] min-w-[700px]';

function DebugDbPage() {
  const { developer } = useSettings();
  const navigate = useNavigate();

  useEffect(() => {
    if (!developer.showDatabaseDebug) {
      navigate({ to: '/' });
    }
  }, [developer.showDatabaseDebug, navigate]);

  if (!developer.showDatabaseDebug) {
    return null;
  }

  return (
    <AppShell>
      <div className="w-full p-6">
        <PageHeader title="Database Debug" />
        <DebugDbContent />
      </div>
    </AppShell>
  )
}

function DebugDbContent() {
  const { general } = useSettings();
  const [source, setSource] = useState<string>('');
  const [type, setType] = useState<string>('');
  const [entityFilter, setEntityFilter] = useState('');
  const [maxAgeSeconds, setMaxAgeSeconds] = useState(300);
  const [limit, setLimit] = useState(500);

  const { data: summary } = useQuery({
    queryKey: ['debug-db-summary'],
    queryFn: () => getDebugSummary(),
    staleTime: 30000,
  });

  const { data: rows, isLoading, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['debug-db-rows', source, type, entityFilter, maxAgeSeconds, limit],
    queryFn: () =>
      queryDebugStats({
        data: {
          source: source || undefined,
          type: type || undefined,
          entityFilter: entityFilter || undefined,
          maxAgeSeconds,
          limit,
        },
      }),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const filteredTypes = useMemo(() => {
    if (!summary?.types) return [];
    if (!source) return summary.types;
    return summary.types.filter((t) => t.startsWith(`${source}/`));
  }, [summary?.types, source]);

  const handleSourceChange = useCallback((_e: unknown, value: string | null) => {
    setSource(value ?? '');
    setType('');
  }, []);

  const listRef = useRef<HTMLDivElement>(null);
  const flatRows = rows ?? [];

  const virtualizer = useWindowVirtualizer({
    count: flatRows.length,
    estimateSize: () => ROW_HEIGHT_ESTIMATE,
    overscan: OVERSCAN,
    scrollMargin: listRef.current?.offsetTop ?? 0,
    getItemKey: (index) => {
      const row = flatRows[index];
      return `${row.timestamp}-${row.source}-${row.type}-${row.entity}`;
    },
  });

  const items = virtualizer.getVirtualItems();

  const formatTimestamp = useCallback(
    (ts: Date | string) => {
      const date = typeof ts === 'string' ? new Date(ts) : ts;
      return date.toLocaleTimeString(undefined, {
        hour12: general.use12HourTime,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
      });
    },
    [general.use12HourTime],
  );

  const formatValue = useCallback((value: number) => {
    if (Number.isInteger(value)) return value.toString();
    if (Math.abs(value) >= 1000) return value.toFixed(0);
    if (Math.abs(value) >= 1) return value.toFixed(2);
    return value.toPrecision(4);
  }, []);

  return (
    <div className="flex flex-col gap-4">
      {/* Summary */}
      {summary && (
        <div className="flex items-center gap-4 text-sm text-neutral-600 dark:text-neutral-400">
          <span className="flex items-center gap-1">
            <Database size={14} />
            {summary.totalRows.toLocaleString()} total rows
          </span>
          <span>{summary.sources.length} source{summary.sources.length !== 1 ? 's' : ''}</span>
          <span>{summary.types.length} type{summary.types.length !== 1 ? 's' : ''}</span>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-end">
        <FormControl className="min-w-[140px]">
          <FormLabel>Source</FormLabel>
          <Select
            value={source}
            onChange={handleSourceChange}
            placeholder="All"
            size="sm"
          >
            <Option value="">All</Option>
            {summary?.sources.map((s) => (
              <Option key={s} value={s}>{s}</Option>
            ))}
          </Select>
        </FormControl>

        <FormControl className="min-w-[200px]">
          <FormLabel>Type</FormLabel>
          <Select
            value={type}
            onChange={(_e, v) => setType(v ?? '')}
            placeholder="All"
            size="sm"
          >
            <Option value="">All</Option>
            {filteredTypes.map((t) => (
              <Option key={t} value={t}>{t}</Option>
            ))}
          </Select>
        </FormControl>

        <FormControl className="min-w-[160px]">
          <FormLabel>Entity</FormLabel>
          <Input
            value={entityFilter}
            onChange={(e) => setEntityFilter(e.target.value)}
            placeholder="Filter..."
            size="sm"
            startDecorator={<Search size={14} />}
          />
        </FormControl>

        <FormControl className="min-w-[140px]">
          <FormLabel>Time Range</FormLabel>
          <Select
            value={maxAgeSeconds}
            onChange={(_e, v) => { if (v !== null) setMaxAgeSeconds(v); }}
            size="sm"
          >
            {TIME_RANGES.map((r) => (
              <Option key={r.seconds} value={r.seconds}>{r.label}</Option>
            ))}
          </Select>
        </FormControl>

        <FormControl className="min-w-[100px]">
          <FormLabel>Limit</FormLabel>
          <Select
            value={limit}
            onChange={(_e, v) => { if (v !== null) setLimit(v); }}
            size="sm"
          >
            {ROW_LIMITS.map((l) => (
              <Option key={l} value={l}>{l.toLocaleString()}</Option>
            ))}
          </Select>
        </FormControl>

        <Button
          variant="outlined"
          size="sm"
          onClick={() => refetch()}
          loading={isFetching}
          startDecorator={<RefreshCw size={14} />}
        >
          Refresh
        </Button>
      </div>

      {/* Status line */}
      {rows && (
        <div className="flex items-center gap-3 text-xs text-neutral-500">
          <span>{flatRows.length.toLocaleString()} row{flatRows.length !== 1 ? 's' : ''} returned</span>
          {dataUpdatedAt > 0 && (
            <span>
              Fetched at {new Date(dataUpdatedAt).toLocaleTimeString(undefined, {
                hour12: general.use12HourTime,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })}
            </span>
          )}
          {flatRows.length >= limit && (
            <Alert color="warning" variant="soft" size="sm">
              Result capped at {limit} rows. Increase limit or narrow filters.
            </Alert>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <Alert color="danger" variant="soft">
          Error querying database: {error.message}
        </Alert>
      )}

      {/* Loading */}
      {isLoading && (
        <Box className="flex justify-center p-4">
          <CircularProgress />
        </Box>
      )}

      {/* Table */}
      {rows && rows.length > 0 && (
        <Sheet variant="outlined" className="rounded-sm overflow-hidden">
          {/* Column headers */}
          <div className={`${DEBUG_GRID} border-b border-neutral-200 dark:border-neutral-700`}>
            <div className="px-3 py-2 font-semibold text-xs whitespace-nowrap">Timestamp</div>
            <div className="px-3 py-2 font-semibold text-xs whitespace-nowrap">Source</div>
            <div className="px-3 py-2 font-semibold text-xs whitespace-nowrap">Type</div>
            <div className="px-3 py-2 font-semibold text-xs whitespace-nowrap">Entity</div>
            <div className="px-3 py-2 font-semibold text-xs text-right whitespace-nowrap">Value</div>
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
                    <DebugRow
                      key={virtualRow.key}
                      row={row}
                      index={virtualRow.index}
                      measureRef={virtualizer.measureElement}
                      formatTimestamp={formatTimestamp}
                      formatValue={formatValue}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        </Sheet>
      )}

      {/* Empty state */}
      {rows && rows.length === 0 && !isLoading && (
        <Box className="flex justify-center p-8">
          <Typography level="body-sm" className="text-neutral-500">
            No rows found matching the current filters.
          </Typography>
        </Box>
      )}
    </div>
  )
}

function DebugRow({
  row,
  index,
  measureRef,
  formatTimestamp,
  formatValue,
}: {
  row: DebugStatRow;
  index: number;
  measureRef: (el: HTMLElement | null) => void;
  formatTimestamp: (ts: Date | string) => string;
  formatValue: (value: number) => string;
}) {
  const stripe = index % 2 === 0
    ? ''
    : 'bg-neutral-50 dark:bg-neutral-900';

  return (
    <div
      data-index={index}
      ref={measureRef}
      className={`${DEBUG_GRID} items-center text-xs ${stripe} hover:bg-blue-50 dark:hover:bg-blue-950/30`}
    >
      <div className="px-3 py-1.5 font-mono text-neutral-600 dark:text-neutral-400 truncate">
        {formatTimestamp(row.timestamp)}
      </div>
      <div className="px-3 py-1.5">
        <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-neutral-100 dark:bg-neutral-800">
          {row.source}
        </span>
      </div>
      <div className="px-3 py-1.5 font-mono truncate" title={row.type}>
        {row.type}
      </div>
      <div className="px-3 py-1.5 font-mono truncate" title={row.entity}>
        {row.entity}
      </div>
      <div className="px-3 py-1.5 font-mono text-right tabular-nums">
        {formatValue(row.value)}
      </div>
    </div>
  );
}
