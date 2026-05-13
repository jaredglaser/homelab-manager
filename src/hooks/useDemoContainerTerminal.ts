import { useEffect, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';

interface UseContainerTerminalOptions {
  containerId: string;
  host: string;
  shell: string;
  terminal: Terminal | null;
  enabled?: boolean;
}

interface UseContainerTerminalResult {
  isConnected: boolean;
  error: Error | null;
  resolvedShell?: string;
  sessionEnded: boolean;
  reconnect: () => void;
}

const BANNER = [
  '\x1b[1;33m[Demo Mode]\x1b[0m This is a simulated terminal session.',
  'No real shell is connected. Type anything and press Enter.',
  '',
].join('\r\n');

const PROMPT = '$ ';

export function useContainerTerminal({
  terminal,
  enabled = true,
}: UseContainerTerminalOptions): UseContainerTerminalResult {
  const activeRef = useRef(false);

  useEffect(() => {
    if (!terminal || !enabled || activeRef.current) return;
    activeRef.current = true;

    terminal.write(BANNER + PROMPT);

    let line = '';

    const dataListener = terminal.onData((data) => {
      const code = data.charCodeAt(0);

      if (data === '\r') {
        terminal.write('\r\n');
        if (line.trim()) terminal.write(`you typed: ${line}\r\n`);
        line = '';
        terminal.write(PROMPT);
      } else if (code === 0x7f) {
        // Backspace
        if (line.length > 0) {
          line = line.slice(0, -1);
          terminal.write('\b \b');
        }
      } else if (code >= 0x20) {
        // Printable character
        line += data;
        terminal.write(data);
      }
    });

    return () => {
      dataListener.dispose();
      activeRef.current = false;
    };
  }, [terminal, enabled]);

  return {
    isConnected: true,
    error: null,
    resolvedShell: 'demo',
    sessionEnded: false,
    reconnect: () => {},
  };
}
