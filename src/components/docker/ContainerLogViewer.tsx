import { memo, useEffect, useRef, useState } from 'react';
import { Paper, Typography } from '@mui/material';
import type { Terminal as TerminalType } from '@xterm/xterm';
import { useContainerLogs } from '@/hooks/useContainerLogs';
import { getCssVar } from '@/lib/charts/css-vars';

interface ContainerLogViewerProps {
  containerId: string;
  host: string;
}

export default memo(function ContainerLogViewer({
  containerId,
  host,
}: ContainerLogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [terminal, setTerminal] = useState<TerminalType | null>(null);
  const terminalRef = useRef<TerminalType | null>(null);
  const fitAddonRef = useRef<{ fit(): void } | null>(null);

  // Dynamically import xterm.js (CJS modules - must be loaded at runtime, not statically)
  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;

    void (async () => {
      try {
        const [xtermMod, fitMod] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
        ]);

        // Also load the stylesheet
        await import('@xterm/xterm/css/xterm.css');

        if (disposed) return;

        // Handle CJS default export (bun) vs ESM named export (Vite)
        const xtermAny = xtermMod as Record<string, unknown>;
        const Terminal = (xtermAny.Terminal ?? (xtermAny.default as Record<string, unknown>).Terminal) as typeof TerminalType;
        const fitAny = fitMod as Record<string, unknown>;
        const FitAddon = (fitAny.FitAddon ?? (fitAny.default as Record<string, unknown>).FitAddon) as new () => import('@xterm/xterm').ITerminalAddon & { fit(): void };

        const bg = getCssVar('--mui-palette-background-chartBg');
        const fg = getCssVar('--chart-text-muted');

        const term = new Terminal({
          disableStdin: true,
          convertEol: true,
          fontSize: 12,
          fontFamily: 'monospace',
          scrollback: 2000,
          theme: {
            ...(bg && { background: bg }),
            ...(fg && { foreground: fg }),
          },
        });

        const fitAddon = new FitAddon();
        fitAddonRef.current = fitAddon;
        term.loadAddon(fitAddon);
        term.open(containerRef.current!);

        requestAnimationFrame(() => {
          try {
            fitAddon.fit();
          } catch {
            // Container may not be visible yet
          }
        });

        terminalRef.current = term;
        setTerminal(term);
      } catch (err) {
        console.error('Failed to initialize terminal:', err);
      }
    })();

    return () => {
      disposed = true;
      fitAddonRef.current = null;
      terminalRef.current?.dispose();
      terminalRef.current = null;
    };
  }, []);

  // Re-fit on container resize
  useEffect(() => {
    if (!containerRef.current || !fitAddonRef.current) return;

    const observer = new ResizeObserver(() => {
      try {
        fitAddonRef.current?.fit();
      } catch {
        // Ignore fit errors during layout transitions
      }
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [terminal]);

  const { isConnected, error } = useContainerLogs({
    containerId,
    host,
    terminal,
  });

  return (
    <Paper
      elevation={0}
      className="relative rounded-sm !bg-[var(--mui-palette-background-chartBg)] h-full min-h-[340px] flex flex-col overflow-hidden"
    >
      <Typography variant="body2" className="p-3 pb-0 font-medium">
        Logs
      </Typography>
      <div ref={containerRef} className="flex-1 px-2 pb-2 min-h-0" />
      {!isConnected && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-sm">
          <Typography variant="body2" className="text-neutral-400">
            Connecting...
          </Typography>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-sm">
          <Typography variant="body2" color="error">
            {error.message}
          </Typography>
        </div>
      )}
    </Paper>
  );
});
