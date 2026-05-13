import { useCallback, useEffect, useRef, useState } from 'react';
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
  /** Shell the agent actually spawned. Set by the server's control frame; undefined until received. */
  resolvedShell?: string;
  /** True after a clean WS close (code 1000/1001), e.g. user typed `exit`. Reset on reconnect. */
  sessionEnded: boolean;
  /** Tears down the current WS and opens a fresh one with the same params. */
  reconnect: () => void;
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
  const [resolvedShell, setResolvedShell] = useState<string | undefined>(undefined);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [reconnectKey, setReconnectKey] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);

  const reconnect = useCallback(() => setReconnectKey((k) => k + 1), []);

  useEffect(() => {
    if (!enabled || !terminal) return;

    const cols = terminal.cols;
    const rows = terminal.rows;

    const wsScheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const path = apiUrl(`/api/docker-exec/${encodeURIComponent(containerId)}`);
    const url = `${wsScheme}//${window.location.host}${path}?host=${encodeURIComponent(host)}&shell=${encodeURIComponent(shell)}&cols=${cols}&rows=${rows}`;

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
        return;
      }
      // Text frames are JSON control messages from the agent (e.g. resolved
      // shell). Anything that doesn't parse is silently dropped rather than
      // written to the terminal: a stray text frame is a protocol bug, not
      // user-visible output.
      try {
        const msg = JSON.parse(event.data as string) as { type?: string; name?: string };
        if (msg.type === 'shell' && typeof msg.name === 'string') {
          setResolvedShell(msg.name);
        } else if (msg.type) {
          console.warn('[useContainerTerminal] unknown control frame type:', msg.type);
        }
      } catch {
        // Non-JSON text frame; ignore.
      }
    };

    ws.onclose = (event) => {
      setIsConnected(false);
      wsRef.current = null;
      if (event.code === 1000 || event.code === 1001) {
        setSessionEnded(true);
      } else {
        setError(new Error(event.reason || 'Terminal session closed unexpectedly'));
      }
    };

    ws.onerror = (e) => {
      // Without surfacing an error here, the UI would wait forever on the close
      // handler, which may not fire (or may fire with an empty reason) when the
      // browser cannot reach the server at all. A subsequent close handler with
      // a specific reason will overwrite this generic message.
      console.error('[useContainerTerminal] ws error', e);
      setIsConnected(false);
      setError(new Error('Terminal WebSocket error'));
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
      // Detach handlers before close: ws.close() schedules an async 'close'
      // event that would otherwise fire setState after the component has
      // unmounted.
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      dataListener.dispose();
      resizeListener.dispose();
      ws.close(1000);
      wsRef.current = null;
      setIsConnected(false);
      setError(null);
      setResolvedShell(undefined);
      setSessionEnded(false);
    };
  }, [containerId, host, shell, terminal, enabled, reconnectKey]);

  return { isConnected, error, resolvedShell, sessionEnded, reconnect };
}
