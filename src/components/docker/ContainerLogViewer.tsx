import { memo, useEffect, useState } from 'react';
import type { Terminal as TerminalType } from '@xterm/xterm';
import { Skeleton } from '@/components/ui/skeleton';
import { useXtermSetup } from '@/hooks/useXtermSetup';
import { useContainerLogs } from '@/hooks/useContainerLogs';

interface ContainerLogViewerProps {
  containerId: string;
  host: string;
  wordWrap: boolean;
}

const MIN_THUMB_HEIGHT = 24;

interface ThumbState {
  top: number;
  height: number;
  trackHeight: number;
}

function computeThumbFromTerminal(terminal: TerminalType, trackHeight: number): ThumbState | null {
  const totalLines = terminal.buffer.active.length;
  const visibleLines = terminal.rows;
  if (totalLines <= visibleLines || trackHeight <= 0) return null;
  const ratio = visibleLines / totalLines;
  const height = Math.max(trackHeight * ratio, MIN_THUMB_HEIGHT);
  const maxThumbTop = trackHeight - height;
  const maxScroll = totalLines - visibleLines;
  const viewportY = terminal.buffer.active.viewportY;
  const top = maxScroll > 0 ? (viewportY / maxScroll) * maxThumbTop : 0;
  return { top, height, trackHeight };
}

// Overlay scrollbar pinned to the visible right edge of the log viewer.
// xterm.js v5's DOM renderer draws its own `.scrollbar.vertical` div inside
// `.xterm-scrollable-element`, which moves with horizontal scroll. We hide
// that one (App.css) and render this one as a sibling of the scroll
// container so it stays put. Scroll state is read from xterm's buffer API
// and written back via `scrollToLine`.
function CustomVerticalScrollbar({ terminal }: { terminal: TerminalType | null }) {
  const [thumb, setThumb] = useState<ThumbState | null>(null);

  useEffect(() => {
    const root = terminal?.element;
    if (!terminal || !root) return;

    const update = () => {
      const next = computeThumbFromTerminal(terminal, root.clientHeight);
      setThumb((prev) => {
        if (!prev && !next) return prev;
        if (prev && next && prev.top === next.top && prev.height === next.height && prev.trackHeight === next.trackHeight) return prev;
        return next;
      });
    };

    const scrollDisp = terminal.onScroll(update);
    const renderDisp = terminal.onRender(update);
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(root);
    update();

    return () => {
      scrollDisp.dispose();
      renderDisp.dispose();
      resizeObserver.disconnect();
    };
  }, [terminal]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!terminal || !thumb) return;
    e.preventDefault();
    const totalLines = terminal.buffer.active.length;
    const visibleLines = terminal.rows;
    const maxScroll = totalLines - visibleLines;
    if (maxScroll <= 0) return;
    const maxThumbTop = thumb.trackHeight - thumb.height;
    if (maxThumbTop <= 0) return;
    const linesPerPixel = maxScroll / maxThumbTop;
    const startY = e.clientY;
    const startScroll = terminal.buffer.active.viewportY;

    const onMove = (ev: PointerEvent) => {
      const targetLine = Math.round(startScroll + (ev.clientY - startY) * linesPerPixel);
      terminal.scrollToLine(Math.max(0, Math.min(maxScroll, targetLine)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div
      data-testid="log-vertical-scrollbar"
      className="absolute top-0 right-0 bottom-0 w-2 z-10 pointer-events-none"
    >
      {thumb && (
        <div
          onPointerDown={handlePointerDown}
          className="absolute right-0 w-2 rounded-sm pointer-events-auto cursor-pointer"
          style={{
            top: thumb.top,
            height: thumb.height,
            backgroundColor: 'color-mix(in srgb, var(--foreground) 35%, transparent)',
          }}
        />
      )}
    </div>
  );
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

  const showSkeleton = !ready && !error;

  return (
    <div className="relative rounded-sm bg-(--chart-bg)! h-full min-h-0 flex flex-col overflow-hidden">
      <div className="relative flex-1 min-h-0">
        <div
          ref={containerRef}
          className={`xterm-log-viewer absolute inset-0 p-2 transition-opacity duration-300 ${!wordWrap ? 'overflow-x-auto overflow-y-hidden' : ''} ${showSkeleton ? 'opacity-0' : 'opacity-100'}`}
        />
        {!showSkeleton && !error && <CustomVerticalScrollbar terminal={terminal} />}
      </div>
      {showSkeleton && (
        <div className="absolute inset-0 top-10 px-3 pb-3 flex flex-col gap-1">
          {Array.from({ length: 14 }, (_, i) => (
            <Skeleton
              key={i}
              className="h-4 rounded bg-(--accent)!"
              style={{ width: `${45 + ((i * 37) % 50)}%` }}
            />
          ))}
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-sm">
          <p className="text-sm text-destructive">{error.message}</p>
        </div>
      )}
    </div>
  );
});
