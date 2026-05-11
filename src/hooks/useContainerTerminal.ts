import { useEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import { apiUrl } from '@/lib/utils/api-url';

interface UseContainerTerminalOptions {
  containerId: string;
  host: string;
  shell: string;
  terminal: Terminal | null;
  /** Default true. Set false to defer connection (e.g. before the xterm element is mounted). */
  enabled?: boolean;
}

interface UseContainerTerminalResult {
  isConnected: boolean;
  error: Error | null;
}

/**
 * Opens a WebSocket to the Nitro proxy route `/api/docker-exec/:containerId`,
 * wires xterm.js stdin/stdout, and forwards terminal resize events.
 *
 * The server proxies the connection to the appropriate agent sidecar identified
 * by the `host` query param. Binary frames (ArrayBuffer) from the server are
 * written directly to the terminal as Uint8Array. Text typed by the user is
 * forwarded as raw strings; resize events are sent as
 * `{"type":"resize","cols":N,"rows":N}` JSON.
 *
 * Code 1000/1001 are clean closes (user closed tab, component unmount); any
 * other close code is treated as an error.
 */
export function useContainerTerminal({
  containerId,
  host,
  shell,
  terminal,
  enabled = true,
}: UseContainerTerminalOptions): UseContainerTerminalResult {
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!enabled || !terminal) return;

    const cols = terminal.cols;
    const rows = terminal.rows;

    const httpBase = apiUrl(`/api/docker-exec/${encodeURIComponent(containerId)}`);
    // Replace http(s) scheme with ws(s) to build the WebSocket URL.
    const wsBase = httpBase.replace(/^http/, 'ws');
    const url = `${window.location.protocol === 'https:' ? wsBase.replace(/^ws:/, 'wss:') : wsBase}?host=${encodeURIComponent(host)}&shell=${encodeURIComponent(shell)}&cols=${cols}&rows=${rows}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      setIsConnected(true);
      setError(null);
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        terminal.write(new Uint8Array(event.data));
      } else {
        terminal.write(event.data as string);
      }
    };

    ws.onclose = (event) => {
      setIsConnected(false);
      wsRef.current = null;
      if (event.code !== 1000 && event.code !== 1001) {
        setError(new Error(event.reason || 'Terminal session closed unexpectedly'));
      }
    };

    ws.onerror = () => {
      setIsConnected(false);
    };

    const dataListener = terminal.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    const resizeListener = terminal.onResize(({ cols: c, rows: r }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: c, rows: r }));
      }
    });

    return () => {
      dataListener.dispose();
      resizeListener.dispose();
      ws.close(1000);
      wsRef.current = null;
      setIsConnected(false);
      setError(null);
    };
  }, [containerId, host, shell, terminal, enabled]);

  return { isConnected, error };
}
