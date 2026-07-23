import { useCallback, useRef, useState } from 'react';
import type { z } from 'zod';
import { useEventSource } from '@/hooks/useEventSource';
import { apiUrl } from '@/lib/utils/api-url';
import type { SseChannelDescriptor } from '@/lib/sse/define-sse-channel';

export interface UseSseChannelOptions<TRevived> {
  /** Called with each validated, revived message. */
  onData: (data: TRevived) => void;
  /** Fired on open after a prior connection failure; see `useEventSource`'s `onReconnect`. */
  onReconnect?: () => void;
  /** Fired when the server emits this channel's named error event (not a socket-level connection error). */
  onServiceError?: () => void;
  /** Message for the `Error` this hook surfaces when the server-side error event fires. */
  serviceErrorMessage?: string;
  debug?: boolean;
}

export interface UseSseChannelResult {
  isConnected: boolean;
  error: Error | null;
}

/** Typed channel layer on `useEventSource`: schema-validates + revives each message, and owns service-error state so consumer hooks don't each reassemble it. */
export function useSseChannel<TSchema extends z.ZodTypeAny, TRevived>(
  channel: SseChannelDescriptor<TSchema, TRevived>,
  options: UseSseChannelOptions<TRevived>,
): UseSseChannelResult {
  const [serviceError, setServiceError] = useState<Error | null>(null);

  const onDataRef = useRef(options.onData);
  onDataRef.current = options.onData;
  const onServiceErrorRef = useRef(options.onServiceError);
  onServiceErrorRef.current = options.onServiceError;

  const handleRawData = useCallback((raw: unknown) => {
    const parsed = channel.schema.safeParse(raw);
    if (!parsed.success) {
      console.error(`[useSseChannel] Invalid message on ${channel.url}:`, parsed.error);
      return;
    }
    setServiceError(null);
    onDataRef.current(channel.revive(parsed.data));
  }, [channel]);

  const handleServiceError = useCallback(() => {
    setServiceError(new Error(options.serviceErrorMessage ?? `${channel.url} stream unavailable`));
    onServiceErrorRef.current?.();
  }, [channel.url, options.serviceErrorMessage]);

  const { isConnected, error: sseError } = useEventSource<unknown>({
    url: apiUrl(channel.url),
    onData: handleRawData,
    onServiceError: handleServiceError,
    onReconnect: options.onReconnect,
    errorEventName: channel.errorEvent,
    debug: options.debug,
  });

  return { isConnected, error: sseError ?? serviceError };
}
