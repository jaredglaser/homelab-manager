import { type ReactNode, useState, useCallback } from 'react';
import Table from '@mui/joy/Table';
import { Alert, Box, CircularProgress, Sheet, Typography } from '@mui/joy';
import { AlertTriangle } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useSSE } from '@/hooks/useSSE';

const STALE_THRESHOLD_MS = 30000; // 30 seconds
const STALE_CHECK_INTERVAL_MS = 5000; // Check every 5 seconds

export interface ColumnDef {
  label: string;
  width?: string;
  align?: 'left' | 'right' | 'center';
}

interface StreamingTableProps<TRaw, TState> {
  ariaLabel: string;
  columns: ColumnDef[];
  sseUrl: string;
  initialState: TState;
  onData: (prev: TState, data: TRaw) => TState;
  renderRows: (state: TState) => ReactNode;
  tableProps?: Record<string, unknown>;
  errorLabel?: string;
}

export default function StreamingTable<TRaw, TState>({
  ariaLabel,
  columns,
  sseUrl,
  initialState,
  onData,
  renderRows,
  tableProps,
  errorLabel,
}: StreamingTableProps<TRaw, TState>) {
  const [state, setState] = useState<TState>(initialState);
  const [hasData, setHasData] = useState(false);
  const [lastDataTime, setLastDataTime] = useState<number | null>(null);

  const handleData = useCallback(
    (data: TRaw) => {
      setState((prev) => onData(prev, data));
      setHasData(true);
      setLastDataTime(Date.now());
    },
    [onData],
  );

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

  const { isConnected, error } = useSSE<TRaw>({
    url: sseUrl,
    onData: handleData,
  });

  if (error && !hasData) {
    return (
      <Box className="w-full">
        <Box className="p-2">
          <Typography color="danger">
            {errorLabel ?? 'Error connecting to data stream'}: {error.message}
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
      <Sheet variant="outlined" className="rounded-sm overflow-auto">
        <Table aria-label={ariaLabel} sx={tableProps}>
          <thead>
            <tr>
              {columns.map((col, i) => (
                <th
                  key={i}
                  style={{
                    ...(col.width ? { width: col.width } : {}),
                    ...(col.align ? { textAlign: col.align } : {}),
                  }}
                  className={`font-semibold ${col.align === 'right' ? 'text-right' : ''}`}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{renderRows(state)}</tbody>
        </Table>
      </Sheet>
    </Box>
  );
}
