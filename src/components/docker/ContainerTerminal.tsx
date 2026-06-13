import { memo, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
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
  wordWrap: boolean;
  /** Called when the agent reports which shell it actually spawned (for `auto`). */
  onShellResolved?: (shell: string) => void;
}

export default memo(function ContainerTerminal({
  containerId,
  host,
  shell,
  frozen,
  wordWrap,
  onShellResolved,
}: ContainerTerminalProps) {
  const { containerRef, terminal, error: setupError, setWordWrap } = useXtermSetup({
    disableStdin: false,
    cursorBlink: true,
    convertEol: true,
  });
  const [ready, setReady] = useState(false);

  // terminal is a dep so this re-runs once the xterm instance is ready
  useEffect(() => {
    setWordWrap(wordWrap);
  }, [terminal, wordWrap, setWordWrap]);

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
    <div className="relative rounded-sm bg-(--chart-bg)! h-full min-h-0 flex flex-col overflow-hidden">
      <div
        ref={containerRef}
        className={`flex-1 p-2 min-h-0 transition-opacity duration-300 ${!wordWrap ? 'overflow-x-auto overflow-y-hidden' : ''} ${showSkeleton ? 'opacity-0' : 'opacity-100'}`}
      />
      {showSkeleton && (
        <div className="absolute inset-0 px-3 pb-3 flex flex-col gap-1 pt-2">
          {Array.from({ length: 14 }, (_, i) => (
            <Skeleton
              key={i}
              className="h-4 rounded bg-(--accent)!"
              style={{ width: `${45 + ((i * 37) % 50)}%` }}
            />
          ))}
        </div>
      )}
      {frozen && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 rounded-sm">
          <p className="text-sm text-(--text-disabled)">Container stopped</p>
        </div>
      )}
      {error && !frozen && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-sm">
          <p className="text-sm text-destructive">{error.message}</p>
        </div>
      )}
      {sessionEnded && !frozen && !error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 rounded-sm gap-3">
          <p className="text-sm text-(--text-disabled)">Session ended</p>
          <Button size="sm" variant="outline" onClick={reconnect}>
            Reconnect
          </Button>
        </div>
      )}
    </div>
  );
});
