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
 * Raw ANSI escape codes are preserved - xterm.js handles rendering them natively.
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

  useEffect(() => {
    if (!enabled || !terminal) return;

    let mounted = true;

    const url = apiUrl(`/api/docker-logs/${encodeURIComponent(containerId)}?host=${encodeURIComponent(host)}`);
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      if (mounted) {
        setIsConnected(true);
        setError(null);
        reconnectAttemptsRef.current = 0;
      }
    };

    eventSource.onmessage = (event) => {
      if (!mounted || !terminalRef.current) return;
      try {
        const data = JSON.parse(event.data) as {
          lines: { text: string; stream: string }[];
        };
        for (const line of data.lines) {
          terminalRef.current.writeln(line.text);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    eventSource.addEventListener('log_error', (event) => {
      if (!mounted) return;
      try {
        const data = JSON.parse((event as MessageEvent).data) as { message?: string };
        const msg = data.message ?? 'Log stream error';
        if (terminalRef.current) {
          terminalRef.current.writeln(`\x1b[31m[Error] ${msg}\x1b[0m`);
        }
      } catch {
        // Ignore parse errors
      }
    });

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
