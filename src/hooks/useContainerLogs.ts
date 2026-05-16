import { useEffect, useState, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import { subscribeToContainerLogs, type LogStreamSubscriber } from '@/lib/docker/log-stream-registry';

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
 * Subscribe to a container's log stream and write its lines into an xterm.js Terminal.
 *
 * Backs onto a shared registry so multiple consumers (e.g. the row's recent-logs
 * panel and the modal viewing the same container) share one EventSource and one
 * backlog buffer. Late joiners get the buffer replayed into their own terminal.
 *
 * Per-terminal write batching: log lines accumulate in a ref-held buffer and
 * flush in a single `terminal.write()` per animation frame to avoid forcing a
 * paint for every incoming line.
 */
export function useContainerLogs({
  containerId,
  host,
  terminal,
  enabled = true,
}: UseContainerLogsOptions): UseContainerLogsResult {
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const terminalRef = useRef(terminal);
  terminalRef.current = terminal;

  const writeBufferRef = useRef<string[]>([]);
  const rafIdRef = useRef(0);

  useEffect(() => {
    if (!enabled || !terminal) return;

    let mounted = true;

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

    const subscriber: LogStreamSubscriber = {
      onLine: (line) => {
        if (!mounted) return;
        writeBufferRef.current.push(line.text);
        scheduleFlush();
      },
      onConnect: () => {
        if (!mounted) return;
        setIsConnected(true);
        setError(null);
      },
      onDisconnect: (cleanEnd) => {
        if (!mounted) return;
        setIsConnected(false);
        if (!cleanEnd) {
          terminalRef.current?.writeln('\x1b[31m[Error] Connection lost\x1b[0m');
        }
      },
      onError: (err) => {
        if (!mounted) return;
        setError(err);
      },
      onClear: () => {
        if (!mounted) return;
        writeBufferRef.current.length = 0;
        if (rafIdRef.current !== 0) {
          cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = 0;
        }
        terminalRef.current?.clear();
      },
    };

    const unsubscribe = subscribeToContainerLogs({ host, containerId, subscriber });

    return () => {
      mounted = false;
      setIsConnected(false);
      setError(null);
      if (rafIdRef.current !== 0) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = 0;
      }
      writeBufferRef.current.length = 0;
      unsubscribe();
    };
  }, [containerId, host, terminal, enabled]);

  return { isConnected, error };
}
