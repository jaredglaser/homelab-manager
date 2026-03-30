import { useEffect, useState, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import { apiUrl } from '@/lib/utils/api-url';

const MAX_RECONNECT_ATTEMPTS = 5;

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
 * Reconnects automatically up to MAX_RECONNECT_ATTEMPTS times on connection loss.
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
  const terminalRef = useRef(terminal);
  terminalRef.current = terminal;
  const hasConnectedRef = useRef(false);

  useEffect(() => {
    if (!enabled || !terminal) return;

    let mounted = true;

    const url = apiUrl(`/api/docker-logs/${encodeURIComponent(containerId)}?host=${encodeURIComponent(host)}`);
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      if (!mounted) return;
      setIsConnected(true);
      setError(null);
      reconnectAttemptsRef.current = 0;

      // Clear terminal on reconnection to prevent duplicate backlog lines
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
          terminalRef.current.writeln(line.text);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    // backlog_done is informational — listening prevents EventSource from treating it as an unknown event type
    eventSource.addEventListener('backlog_done', () => {});

    const handleLogError = (event: Event) => {
      if (!mounted) return;
      try {
        const data = JSON.parse((event as MessageEvent).data) as { message?: string; error?: string };
        const msg = data.message ?? data.error ?? 'Log stream error';
        if (terminalRef.current) {
          terminalRef.current.writeln(`\x1b[31m[Error] ${msg}\x1b[0m`);
        }
      } catch {
        // Ignore parse errors
      }
    };

    eventSource.addEventListener('log_error', handleLogError);
    eventSource.addEventListener('error', handleLogError);

    eventSource.onerror = () => {
      if (mounted) {
        setIsConnected(false);
        reconnectAttemptsRef.current++;

        if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
          setError(new Error('Log connection failed after multiple attempts'));
          eventSource.close();
          eventSourceRef.current = null;
        }
      }
    };

    return () => {
      mounted = false;
      eventSource.close();
      eventSourceRef.current = null;
    };
  }, [containerId, host, terminal, enabled]);

  return { isConnected, error };
}
