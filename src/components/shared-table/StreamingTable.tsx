import { type ReactNode, useState, useCallback } from 'react';
import Table from '@mui/joy/Table';
import { Alert, Box, CircularProgress, Sheet, Typography } from '@mui/joy';
import { AlertTriangle } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useServerStream } from '@/hooks/useServerStream';
import PageHeader from '@/components/PageHeader';

const STALE_THRESHOLD_MS = 30000; // 30 seconds
const STALE_CHECK_INTERVAL_MS = 5000; // Check every 5 seconds

export interface ColumnDef {
  label: string;
  width?: string;
  align?: 'left' | 'right' | 'center';
}

interface StreamingTableProps<TRaw, TState> {
  title: string;
  ariaLabel: string;
  columns: ColumnDef[];
  streamFn: () => Promise<AsyncIterable<TRaw>>;
  initialState: TState;
  onData: (prev: TState, data: TRaw) => TState;
  renderRows: (state: TState) => ReactNode;
  retry?: { enabled: boolean; baseDelay?: number; maxDelay?: number };
  tableProps?: Record<string, any>;
  errorLabel?: string;
}

export default function StreamingTable<TRaw, TState>({
  title,
  ariaLabel,
  columns,
  streamFn,
  initialState,
  onData,
  renderRows,
  retry,
  tableProps,
  errorLabel,
}: StreamingTableProps<TRaw, TState>) {
  const [state, setState] = useState<TState>(initialState);
  const [hasData, setHasData] = useState(false);
  const [lastDataTime, setLastDataTime] = useState<number | null>(null);

  const handleData = useCallback((data: TRaw) => {
    setState(prev => onData(prev, data));
    setHasData(true);
    setLastDataTime(Date.now());
  }, [onData]);

  // Check for stale data periodically using TanStack Query
  const { data: isStale = false } = useQuery({
    queryKey: ['stale-check', lastDataTime],
    queryFn: () => {
      if (!lastDataTime) return false;
      return Date.now() - lastDataTime > STALE_THRESHOLD_MS;
    },
    enabled: hasData,
    refetchInterval: STALE_CHECK_INTERVAL_MS,
    staleTime: 0, // Always consider stale to trigger refetch
  });

  const { isStreaming, error } = useServerStream({
    streamFn,
    onData: handleData,
    retry,
  });

  if (error && !hasData) {
    return (
      <div className="w-full p-6">
        <PageHeader title={title} />
        <Box sx={{ p: 2 }}>
          <Typography color="danger">
            {errorLabel ?? 'Error streaming data'}: {error.message}
          </Typography>
        </Box>
      </div>
    );
  }

  if (!isStreaming && !hasData) {
    return (
      <div className="w-full p-6">
        <PageHeader title={title} />
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
          <CircularProgress />
        </Box>
      </div>
    );
  }

  return (
    <div className="w-full p-6">
      <PageHeader title={title} />
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
      <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto' }}>
        <Table aria-label={ariaLabel} sx={{ '& thead th': { fontWeight: 600 }, ...tableProps }}>
          <thead>
            <tr>
              {columns.map((col, i) => (
                <th
                  key={i}
                  style={{
                    ...(col.width ? { width: col.width } : {}),
                    ...(col.align ? { textAlign: col.align } : {}),
                  }}
                  className={col.align === 'right' ? 'text-right' : undefined}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {renderRows(state)}
          </tbody>
        </Table>
      </Sheet>
    </div>
  );
}
