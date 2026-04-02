import { useEffect, useState, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import { apiUrl } from '@/lib/utils/api-url';

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 16_000;

interface UseContainerLogsOptions {
  containerId: string;
  host: string;
  terminal: Terminal | null;
  enabled?: boolean;
}

interface UseContainerLogsResult {
  isConnected: boolean;
  error: Error | null;
}

/**
 * Streams container logs from the SSE endpoint and writes them to an xterm.js Terminal.
 *
 * The agent streams logs in two phases:
 * 1. **Backlog** — last 200 lines, written to the terminal immediately
 * 2. **Live** — new lines as they arrive, after a `backlog_done` event
 *
 * Clears the terminal on reconnection to prevent duplicate backlog lines.
 * Reconnects with exponential backoff (1s, 2s, 4s, 8s, 16s) up to
 * MAX_RECONNECT_ATTEMPTS times on connection loss.
 */
export function useContainerLogs({
  containerId,
  host,
  terminal,
  enabled = true,
}: UseContainerLogsOptions): UseContainerLogsResult {
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const terminalRef = useRef(terminal);
  terminalRef.current = terminal;
  const hasConnectedRef = useRef(false);

  const writeBufferRef = useRef<string[]>([]);
  const rafIdRef = useRef(0);

  useEffect(() => {
    if (!enabled || !terminal) return;

    let mounted = true;

    /** Flush buffered lines to the terminal in a single write per frame. */
    const scheduleFlush = () => {
      if (rafIdRef.current !== 0) return;
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = 0;
        const buf = writeBufferRef.current;
        if (buf.length === 0 || !terminalRef.current) return;
        terminalRef.current.write(buf.join('\n') + '\n');
        buf.length = 0;
      });
    };

    const connect = () => {
      if (!mounted) return;

      const url = apiUrl(`/api/docker-logs/${encodeURIComponent(containerId)}?host=${encodeURIComponent(host)}`);
      const eventSource = new EventSource(url);
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        if (!mounted) return;
        setIsConnected(true);
        setError(null);
        reconnectAttemptsRef.current = 0;

        if (hasConnectedRef.current && terminalRef.current) {
          terminalRef.current.clear();
        }
        hasConnectedRef.current = true;
      };

      eventSource.onmessage = (event) => {
        if (!mounted || !terminalRef.current) return;
        try {
          const data = JSON.parse(event.data) as
            | { lines: { text: string; stream: string }[] }
            | { text: string; stream: string };
          const lines = 'lines' in data ? data.lines : [data];
          for (const line of lines) {
            writeBufferRef.current.push(line.text);
          }
          scheduleFlush();
        } catch (err) {
          console.error('[useContainerLogs] Failed to parse message:', err, 'Raw data:', event.data?.slice(0, 200));
        }
      };

      // Intentionally empty — both backlog and live phases write to the terminal
      // identically, so no state transition is needed. The listener must be registered
      // to prevent the event from hitting the default onmessage handler.
      eventSource.addEventListener('backlog_done', () => {});

      const handleLogError = (event: Event) => {
        if (!mounted) return;
        try {
          const data = JSON.parse((event as MessageEvent).data) as { message?: string; error?: string };
          const msg = data.message ?? data.error ?? 'Log stream error';
          if (terminalRef.current) {
            terminalRef.current.writeln(`\x1b[31m[Error] ${msg}\x1b[0m`);
          }
        } catch (err) {
          console.error('[useContainerLogs] Failed to parse log_error event:', err, 'Raw data:', (event as MessageEvent).data?.slice(0, 200));
        }
      };

      eventSource.addEventListener('error', handleLogError);

      eventSource.onerror = () => {
        if (!mounted) return;
        setIsConnected(false);

        eventSource.close();
        eventSourceRef.current = null;

        reconnectAttemptsRef.current++;

        if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
          setError(new Error('Log stream disconnected after multiple reconnect attempts. Check that the agent for this host is running and the container still exists.'));
          return;
        }

        const delay = Math.min(
          BASE_BACKOFF_MS * 2 ** (reconnectAttemptsRef.current - 1),
          MAX_BACKOFF_MS,
        );

        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          connect();
        }, delay);
      };
    };

    connect();

    return () => {
      mounted = false;
      setIsConnected(false);
      setError(null);
      reconnectAttemptsRef.current = 0;
      hasConnectedRef.current = false;
      if (rafIdRef.current !== 0) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = 0;
      }
      writeBufferRef.current.length = 0;
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [containerId, host, terminal, enabled]);

  return { isConnected, error };
}
