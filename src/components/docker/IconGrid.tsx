import { memo, useState, useMemo, useRef, useCallback, useEffect, createContext, useContext } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ButtonBase, Skeleton } from '@mui/material';

/** Row-level AbortController context — aborts all in-flight icon loads when the row unmounts. */
const AbortContext = createContext<AbortSignal | null>(null);

const IconCell = memo(function IconCell({ slug, selected, onSelect }: { slug: string; selected: boolean; onSelect: (slug: string) => void }) {
  const [loaded, setLoaded] = useState(false);
  const signal = useContext(AbortContext);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const handleLoad = useCallback(() => setLoaded(true), []);
  const handleError = useCallback(() => setLoaded(true), []);

  useEffect(() => {
    if (!signal) return;
    const onAbort = () => {
      if (imgRef.current) imgRef.current.src = '';
    };
    signal.addEventListener('abort', onAbort);
    return () => signal.removeEventListener('abort', onAbort);
  }, [signal]);

  return (
    <ButtonBase
      onClick={() => onSelect(slug)}
      className={`!flex !flex-col !items-center !p-2 !rounded-md hover:!bg-blue-500/10 ${
        selected ? '!bg-blue-500/20 !ring-1 !ring-blue-500' : ''
      }`}
    >
      <div className="relative w-8 h-8">
        {!loaded && (
          <Skeleton variant="rounded" width={32} height={32} className="!absolute inset-0" />
        )}
        <img
          ref={imgRef}
          src={`${import.meta.env.BASE_URL}icons/${slug}.svg`}
          alt={slug}
          className={`w-8 h-8 ${loaded ? 'visible' : 'invisible'}`}
          onLoad={handleLoad}
          onError={handleError}
        />
      </div>
      <span className="mt-1 text-xs truncate w-full text-center">{slug}</span>
    </ButtonBase>
  );
});

/** Provides a shared AbortController for all IconCells in the row. On unmount, aborts in-flight loads. */
const IconRow = memo(function IconRow({ slugs, currentIcon, onSelect }: { slugs: string[]; currentIcon: string | null; onSelect: (slug: string) => void }) {
  const controllerRef = useRef(new AbortController());

  useEffect(() => {
    return () => controllerRef.current.abort();
  }, []);

  return (
    <AbortContext.Provider value={controllerRef.current.signal}>
      {slugs.map((slug) => (
        <IconCell key={slug} slug={slug} selected={currentIcon === slug} onSelect={onSelect} />
      ))}
    </AbortContext.Provider>
  );
});

const ICON_COLS = 7;
const ICON_ROW_HEIGHT = 76;

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

  const iconRows = useMemo(() => {
    const rows: string[][] = [];
    for (let i = 0; i < filteredIcons.length; i += ICON_COLS) {
      rows.push(filteredIcons.slice(i, i + ICON_COLS));
    }
    return rows;
  }, [filteredIcons]);

  const virtualizer = useVirtualizer({
    count: iconRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ICON_ROW_HEIGHT,
    overscan: 8,
  });

  // When the filtered list changes the virtualizer may still be scrolled to an
  // index that no longer has rows, leaving the user staring at an empty viewport.
  // Reset the scroll position so the first match is always visible.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [filteredIcons]);

  return (
    <div
      ref={scrollRef}
      className="overflow-y-auto h-[50vh] ml-4 mr-2 mb-4 pl-2 pr-2 py-2 rounded-l-xl rounded-r-none !bg-[var(--mui-palette-background-level1)] themed-scrollbar"
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
                className="grid grid-cols-7 gap-2 absolute left-0 w-full"
                style={{
                  height: virtualRow.size,
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
