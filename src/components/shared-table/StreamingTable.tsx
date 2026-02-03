import { type ReactNode, useState, useCallback } from 'react';
import Table from '@mui/joy/Table';
import { Box, CircularProgress, Sheet, Typography } from '@mui/joy';
import { useServerStream } from '@/hooks/useServerStream';

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

  const handleData = useCallback((data: TRaw) => {
    setState(prev => onData(prev, data));
    setHasData(true);
  }, [onData]);

  const { isStreaming, error } = useServerStream({
    streamFn,
    onData: handleData,
    retry,
  });

  if (error && !hasData) {
    return (
      <Box sx={{ width: '100%', p: 3 }}>
        <Typography level="h2" sx={{ mb: 3 }}>{title}</Typography>
        <Box sx={{ p: 2 }}>
          <Typography color="danger">
            {errorLabel ?? 'Error streaming data'}: {error.message}
          </Typography>
        </Box>
      </Box>
    );
  }

  if (!isStreaming && !hasData) {
    return (
      <Box sx={{ width: '100%', p: 3 }}>
        <Typography level="h2" sx={{ mb: 3 }}>{title}</Typography>
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
          <CircularProgress />
        </Box>
      </Box>
    );
  }

  return (
    <Box sx={{ width: '100%', p: 3 }}>
      <Typography level="h2" sx={{ mb: 3 }}>{title}</Typography>
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
    </Box>
  );
}
