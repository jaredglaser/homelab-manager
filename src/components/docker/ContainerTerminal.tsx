import { memo, useEffect, useState } from 'react';
import { Button, Paper, Skeleton, Typography } from '@mui/material';
import { useXtermSetup } from '@/hooks/useXtermSetup';
import { useContainerTerminal } from '@/hooks/useContainerTerminal';
import { useContainerTerminal as useDemoContainerTerminal } from '@/hooks/useDemoContainerTerminal';
import { IS_DEMO_MODE } from '@/lib/constants/demo';

const useTerminalSession = IS_DEMO_MODE ? useDemoContainerTerminal : useContainerTerminal;

interface ContainerTerminalProps {
  containerId: string;
  host: string;
  shell: string;
  frozen: boolean;
  /** Called when the agent reports which shell it actually spawned (for `auto`). */
  onShellResolved?: (shell: string) => void;
}

export default memo(function ContainerTerminal({
  containerId,
  host,
  shell,
  frozen,
  onShellResolved,
}: ContainerTerminalProps) {
  const { containerRef, terminal, error: setupError } = useXtermSetup({
    disableStdin: false,
    cursorBlink: true,
    convertEol: true,
  });
  const [ready, setReady] = useState(false);

  const { isConnected, error: wsError, resolvedShell, sessionEnded, reconnect } = useTerminalSession({
    containerId,
    host,
    shell,
    terminal,
    enabled: !frozen,
  });

  // Surface either failure path: xterm bootstrap (dynamic import) or WS lifecycle.
  const error = setupError ?? wsError;

  useEffect(() => {
    if (resolvedShell && onShellResolved) onShellResolved(resolvedShell);
  }, [resolvedShell, onShellResolved]);

  useEffect(() => {
    if (isConnected && terminal) setReady(true);
  }, [isConnected, terminal]);

  // Block input while the container is stopped
  useEffect(() => {
    if (!terminal) return;
    terminal.options.disableStdin = frozen;
  }, [terminal, frozen]);

  const showSkeleton = !ready && !error && !frozen;

  return (
    <Paper
      elevation={0}
      className="relative rounded-sm bg-(--mui-palette-background-chartBg)! h-full min-h-0 flex flex-col overflow-hidden"
    >
      <div
        ref={containerRef}
        className={`flex-1 px-2 pb-2 min-h-0 transition-opacity duration-300 ${showSkeleton ? 'opacity-0' : 'opacity-100'}`}
      />
      {showSkeleton && (
        <div className="absolute inset-0 px-3 pb-3 flex flex-col gap-1 pt-2">
          {Array.from({ length: 14 }, (_, i) => (
            <Skeleton
              key={i}
              variant="text"
              width={`${45 + ((i * 37) % 50)}%`}
              className="bg-(--mui-palette-action-hover)! text-xs!"
            />
          ))}
        </div>
      )}
      {frozen && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 rounded-sm">
          <Typography variant="body2" className="text-[var(--mui-palette-text-disabled)]">
            Container stopped
          </Typography>
        </div>
      )}
      {error && !frozen && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-sm">
          <Typography variant="body2" color="error">
            {error.message}
          </Typography>
        </div>
      )}
      {sessionEnded && !frozen && !error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 rounded-sm gap-3">
          <Typography variant="body2" className="text-[var(--mui-palette-text-disabled)]">
            Session ended
          </Typography>
          <Button size="small" variant="outlined" onClick={reconnect}>
            Reconnect
          </Button>
        </div>
      )}
    </Paper>
  );
});
