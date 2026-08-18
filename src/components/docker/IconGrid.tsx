import { memo, useState, useMemo, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Skeleton } from '@/components/ui/skeleton';
import { useIsTouch } from '@/hooks/useMediaQuery';
import { cn } from '@/lib/utils/cn';

const IconCell = memo(function IconCell({ slug, selected, onSelect }: { slug: string; selected: boolean; onSelect: (slug: string) => void }) {
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const isTouch = useIsTouch();
  const handleLoad = useCallback(() => setLoaded(true), []);
  const handleError = useCallback(() => setLoaded(true), []);

  // Use fetch+AbortController because browser <img> requests can't be cancelled by
  // setting src=''; the browser completes them anyway. Setting src to the resulting
  // blob URL imperatively keeps React out of src reconciliation entirely.
  useLayoutEffect(() => {
    const controller = new AbortController();
    let blobUrl: string | null = null;

    fetch(`${import.meta.env.BASE_URL}icons/${slug}.svg`, { signal: controller.signal })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error('not ok'))))
      .then((blob) => {
        if (controller.signal.aborted) return;
        blobUrl = URL.createObjectURL(blob);
        if (imgRef.current) imgRef.current.src = blobUrl;
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoaded(true);
      });

    return () => {
      controller.abort();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [slug]);

  return (
    <button
      type="button"
      onClick={() => onSelect(slug)}
      className={cn(
        'flex flex-col items-center p-2 rounded-md cursor-pointer hover:bg-blue-500/10 outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        isTouch && 'tap-target',
        selected && 'bg-blue-500/20 ring-1 ring-blue-500',
      )}
    >
      <div className="relative w-8 h-8">
        {!loaded && (
          <Skeleton className="absolute inset-0 w-8 h-8 rounded" />
        )}
        <img
          ref={imgRef}
          alt={slug}
          className={`w-8 h-8 ${loaded ? 'visible' : 'invisible'}`}
          onLoad={handleLoad}
          onError={handleError}
        />
      </div>
      <span className="mt-1 text-xs truncate w-full text-center">{slug}</span>
    </button>
  );
});

const IconRow = memo(function IconRow({ slugs, currentIcon, onSelect }: { slugs: string[]; currentIcon: string | null; onSelect: (slug: string) => void }) {
  return (
    <>
      {slugs.map((slug) => (
        <IconCell key={slug} slug={slug} selected={currentIcon === slug} onSelect={onSelect} />
      ))}
    </>
  );
});

const ICON_MIN_COLS = 3;
const ICON_MAX_COLS = 7;
const ICON_CELL_MIN_WIDTH = 64;
const ICON_GRID_GAP = 8;
const ICON_ROW_HEIGHT = 76;

/**
 * Number of columns the grid can fit is derived from the measured container
 * width and clamped to [ICON_MIN_COLS, ICON_MAX_COLS]. The same value drives
 * both the CSS `gridTemplateColumns` and the `iconRows` chunking below, so the
 * two can never disagree the way a hardcoded `grid-cols-7` class paired with
 * a separate constant could.
 */
function computeIconCols(containerWidth: number): number {
  if (containerWidth <= 0) return ICON_MAX_COLS;
  const cols = Math.floor((containerWidth + ICON_GRID_GAP) / (ICON_CELL_MIN_WIDTH + ICON_GRID_GAP));
  return Math.min(ICON_MAX_COLS, Math.max(ICON_MIN_COLS, cols));
}

interface IconGridProps {
  filteredIcons: readonly string[];
  currentIcon: string | null;
  onSelect: (slug: string) => void;
  emptyMessage: string;
}

export default function IconGrid({
  filteredIcons,
  currentIcon,
  onSelect,
  emptyMessage,
}: IconGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContainerWidth(entry.contentRect.width);
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const cols = useMemo(() => computeIconCols(containerWidth), [containerWidth]);

  const iconRows = useMemo(() => {
    const rows: string[][] = [];
    for (let i = 0; i < filteredIcons.length; i += cols) {
      rows.push(filteredIcons.slice(i, i + cols));
    }
    return rows;
  }, [filteredIcons, cols]);

  const virtualizer = useVirtualizer({
    count: iconRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ICON_ROW_HEIGHT,
    overscan: 2,
  });

  // When the filtered list changes the virtualizer may still be scrolled to an
  // index that no longer has rows, leaving the user staring at an empty viewport.
  // Reset the scroll position so the first match is always visible.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [filteredIcons, cols]);

  return (
    <div
      ref={scrollRef}
      className="overflow-y-auto h-[50vh] ml-4 mr-2 mb-4 pl-2 pr-2 py-2 rounded-l-xl rounded-r-none bg-(--level1)! themed-scrollbar"
    >
      {filteredIcons.length === 0 ? (
        <p className="text-center py-4 text-sm opacity-70">{emptyMessage}</p>
      ) : (
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', contain: 'layout style' }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = iconRows[virtualRow.index];
            return (
              <div
                key={virtualRow.index}
                className="grid gap-2 absolute left-0 w-full"
                style={{
                  height: virtualRow.size,
                  gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <IconRow slugs={row} currentIcon={currentIcon} onSelect={onSelect} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
