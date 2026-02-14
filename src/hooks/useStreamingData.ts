import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSSE } from '@/hooks/useSSE';

const STALE_THRESHOLD_MS = 30000;
const STALE_CHECK_INTERVAL_MS = 5000;

interface UseStreamingDataOptions<TRaw, TState> {
  /** SSE endpoint URL */
  url: string;
  /** Transform raw SSE data into component state */
  transform: (raw: TRaw) => TState;
  /** Initial state before any data is received */
  initialState: TState;
  /** Unique key for the stale-check query (e.g., 'docker', 'zfs') */
  staleKey: string;
}

interface UseStreamingDataResult<TState> {
  state: TState;
  hasData: boolean;
  isConnected: boolean;
  error: Error | null;
  isStale: boolean;
}

/**
 * Shared hook for SSE-based streaming data with stale detection.
 * Combines useSSE + state management + TanStack Query stale check.
 */
export function useStreamingData<TRaw, TState>({
  url,
  transform,
  initialState,
  staleKey,
}: UseStreamingDataOptions<TRaw, TState>): UseStreamingDataResult<TState> {
  const [state, setState] = useState<TState>(initialState);
  const [hasData, setHasData] = useState(false);
  const [lastDataTime, setLastDataTime] = useState<number | null>(null);

  const handleData = useCallback(
    (raw: TRaw) => {
      setState(transform(raw));
      setHasData(true);
      setLastDataTime(Date.now());
    },
    [transform],
  );

  const { isConnected, error } = useSSE<TRaw>({
    url,
    onData: handleData,
  });

  const { data: isStale = false } = useQuery({
    queryKey: [`stale-check-${staleKey}`, lastDataTime],
    queryFn: () => {
      if (!lastDataTime) return false;
      return Date.now() - lastDataTime > STALE_THRESHOLD_MS;
    },
    enabled: hasData,
    refetchInterval: STALE_CHECK_INTERVAL_MS,
    staleTime: 0,
  });

  return { state, hasData, isConnected, error, isStale };
}
