import { memo, useEffect, useState } from 'react';
import { Paper, Skeleton, Typography } from '@mui/material';
import { useXtermSetup } from '@/hooks/useXtermSetup';
import { useContainerLogs } from '@/hooks/useContainerLogs';

interface ContainerLogViewerProps {
  containerId: string;
  host: string;
  wordWrap: boolean;
}

export default memo(function ContainerLogViewer({
  containerId,
  host,
  wordWrap,
}: ContainerLogViewerProps) {
  const { containerRef, terminal, error: setupError, setWordWrap } = useXtermSetup({ disableStdin: true, convertEol: true });
  const [ready, setReady] = useState(false);

  // terminal is a dep so this re-runs once the xterm instance is ready
  useEffect(() => {
    setWordWrap(wordWrap);
  }, [terminal, wordWrap, setWordWrap]);

  const { isConnected, error: logsError } = useContainerLogs({
    containerId,
    host,
    terminal,
  });

  // Surface either failure path: xterm bootstrap (dynamic import) or logs stream.
  const error = setupError ?? logsError;

  // Mark ready once connected so xterm has painted its first content
  useEffect(() => {
    if (isConnected && terminal) setReady(true);
  }, [isConnected, terminal]);

  // Recalculate no-wrap width after the first write batch lands in the buffer.
  // At terminal-ready time the buffer is empty and cols falls back to NO_WRAP_COLS.
  // onWriteParsed fires once real data has been written, giving us the true max width.
  useEffect(() => {
    if (!terminal || wordWrap) return;
    const disposable = terminal.onWriteParsed(() => {
      disposable.dispose();
      setWordWrap(false);
    });
    return () => disposable.dispose();
  }, [terminal, wordWrap, setWordWrap]);

  // Keep xterm's vertical scrollbar pinned to the visible right edge in no-wrap mode.
  // .xterm-viewport is absolutely positioned at the right edge of the full-width canvas,
  // so without this it scrolls off-screen when the user scrolls left-to-right.
  useEffect(() => {
    if (wordWrap || !terminal || !containerRef.current) return;
    const container = containerRef.current;

    const syncViewport = () => {
      const viewport = container.querySelector<HTMLElement>('.xterm-viewport');
      if (!viewport) return;
      const { scrollLeft, clientWidth, scrollWidth } = container;
      viewport.style.left = `${scrollLeft}px`;
      viewport.style.right = `${Math.max(0, scrollWidth - scrollLeft - clientWidth)}px`;
    };

    container.addEventListener('scroll', syncViewport, { passive: true });
    syncViewport();

    return () => {
      container.removeEventListener('scroll', syncViewport);
      const viewport = container.querySelector<HTMLElement>('.xterm-viewport');
      if (viewport) {
        viewport.style.left = '';
        viewport.style.right = '';
      }
    };
  }, [wordWrap, terminal, containerRef]);

  const showSkeleton = !ready && !error;

  return (
    <Paper
      elevation={0}
      className="relative rounded-sm bg-(--mui-palette-background-chartBg)! h-full min-h-0 flex flex-col overflow-hidden"
    >
      <div
        ref={containerRef}
        className={`flex-1 p-2 min-h-0 transition-opacity duration-300 ${!wordWrap ? 'overflow-x-auto overflow-y-hidden' : ''} ${showSkeleton ? 'opacity-0' : 'opacity-100'}`}
      />
      {showSkeleton && (
        <div className="absolute inset-0 top-10 px-3 pb-3 flex flex-col gap-1">
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
