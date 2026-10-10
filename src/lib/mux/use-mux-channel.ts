import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { z } from 'zod';
import { muxConnection, type MuxStatus } from '@/lib/mux/mux-connection';
import type { MuxTopicFrame } from '@/lib/mux/protocol';

export interface MuxChannel<TSchema extends z.ZodTypeAny, TRevived = z.infer<TSchema>> {
  topic: string;
  schema: TSchema;
  revive?: (raw: z.infer<TSchema>) => TRevived;
}

export interface UseMuxChannelOptions<TRevived> {
  onData: (data: TRevived) => void;
  /** Fired when the server emits this topic's `error` frame (not a connection-level error). */
  onServiceError?: () => void;
  serviceErrorMessage?: string;
}

export interface UseMuxChannelResult {
  isConnected: boolean;
  error: Error | null;
}

export function useMuxChannel<TSchema extends z.ZodTypeAny, TRevived>(
  channel: MuxChannel<TSchema, TRevived>,
  options: UseMuxChannelOptions<TRevived>,
): UseMuxChannelResult {
  const [status, setStatus] = useState<MuxStatus>({ connected: false, error: null });
  const [serviceError, setServiceError] = useState<Error | null>(null);

  const channelRef = useRef(channel);
  channelRef.current = channel;
  const onDataRef = useRef(options.onData);
  onDataRef.current = options.onData;
  const onServiceErrorRef = useRef(options.onServiceError);
  onServiceErrorRef.current = options.onServiceError;
  const serviceErrorMessageRef = useRef(options.serviceErrorMessage);
  serviceErrorMessageRef.current = options.serviceErrorMessage;

  useEffect(() => {
    return muxConnection.subscribe(channel.topic, {
      onEvent: (frame: MuxTopicFrame) => {
        const current = channelRef.current;
        if (frame.kind === 'error') {
          setServiceError(new Error(serviceErrorMessageRef.current ?? `${current.topic} stream unavailable`));
          onServiceErrorRef.current?.();
          return;
        }
        if (frame.kind !== 'data') return;
        const parsed = current.schema.safeParse(frame.payload);
        if (!parsed.success) {
          console.error(`[useMuxChannel] Invalid message on ${current.topic}:`, parsed.error);
          return;
        }
        setServiceError(null);
        onDataRef.current(current.revive ? current.revive(parsed.data) : parsed.data as TRevived);
      },
      onStatus: (next) => {
        setStatus(next);
        if (next.connected) setServiceError(null);
      },
    });
  }, [channel.topic]);

  return { isConnected: status.connected, error: status.error ?? serviceError };
}

export interface UseMuxQueryOptions<TRevived, TState> {
  queryKey: QueryKey;
  initial: TState;
  fold: (state: TState, event: TRevived) => TState;
  serviceErrorMessage?: string;
}

export interface UseMuxQueryResult<TState> {
  state: TState;
  isConnected: boolean;
  error: Error | null;
}

/**
 * Stream-fed TanStack Query cache: frames fold into one cache entry via
 * setQueryData. No queryFn on purpose: the stream is the only source, and
 * re-subscribing re-delivers the topic's initial state.
 */
export function useMuxQuery<TSchema extends z.ZodTypeAny, TRevived, TState>(
  channel: MuxChannel<TSchema, TRevived>,
  options: UseMuxQueryOptions<TRevived, TState>,
): UseMuxQueryResult<TState> {
  const queryClient = useQueryClient();
  const foldRef = useRef(options.fold);
  foldRef.current = options.fold;
  const initialRef = useRef(options.initial);
  initialRef.current = options.initial;

  const { data } = useQuery({
    queryKey: options.queryKey,
    initialData: options.initial,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const queryKeyRef = useRef(options.queryKey);
  queryKeyRef.current = options.queryKey;

  const handleData = useCallback((event: TRevived) => {
    queryClient.setQueryData<TState>(queryKeyRef.current, (prev) =>
      foldRef.current(prev ?? initialRef.current, event));
  }, [queryClient]);

  const { isConnected, error } = useMuxChannel(channel, {
    onData: handleData,
    serviceErrorMessage: options.serviceErrorMessage,
  });

  return { state: data ?? options.initial, isConnected, error };
}
