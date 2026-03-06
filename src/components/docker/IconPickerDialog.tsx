import { memo, useState, useMemo, useRef, useCallback, useEffect, createContext, useContext } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ButtonBase, IconButton, TextField, InputAdornment, Typography, Skeleton } from '@mui/material';
import { Search, X } from 'lucide-react';
import { AVAILABLE_ICONS } from '@/lib/utils/icon-resolver';
import { SELECTION_FEEDBACK_MS } from '@/lib/constants/ui-timing';
import BottomDrawer from '@/components/shared/BottomDrawer';

/** Row-level AbortController context — aborts all in-flight icon loads when the row unmounts. */
const AbortContext = createContext<AbortSignal | null>(null);

const IconCell = memo(function IconCell({ slug, selected, onSelect }: { slug: string; selected: boolean; onSelect: (slug: string) => void }) {
  const [loaded, setLoaded] = useState(false);
  const signal = useContext(AbortContext);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const handleLoad = useCallback(() => setLoaded(true), []);
  const handleError = useCallback(() => setLoaded(true), []);

  // Abort: remove src to cancel the in-flight request when the row unmounts
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

interface IconPickerDialogProps {
  open: boolean;
  onClose: () => void;
  onSelect: (iconSlug: string) => void;
  currentIcon: string | null;
  containerName: string;
}

export default function IconPickerDialog({
  open,
  onClose,
  onSelect,
  currentIcon,
  containerName,
}: IconPickerDialogProps) {
  const [search, setSearch] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Cleanup selection feedback timer on unmount
  useEffect(() => {
    return () => clearTimeout(feedbackTimerRef.current);
  }, []);

  const filteredIcons = useMemo(() => {
    if (!search.trim()) return AVAILABLE_ICONS;
    const term = search.toLowerCase();
    return AVAILABLE_ICONS.filter((icon) => icon.includes(term));
  }, [search]);

  // Chunk flat icon list into rows of ICON_COLS
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

  const handleSelect = useCallback((iconSlug: string) => {
    onSelect(iconSlug);
    feedbackTimerRef.current = setTimeout(() => {
      onClose();
      setSearch('');
    }, SELECTION_FEEDBACK_MS);
  }, [onSelect, onClose]);

  const handleClose = useCallback(() => {
    onClose();
    setSearch('');
  }, [onClose]);

  return (
    <BottomDrawer open={open} onClose={handleClose}>
      <div className="flex flex-col min-h-0">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-2 pb-3 select-none">
          <Typography variant="h6">Select Icon for {containerName}</Typography>
          <IconButton onClick={handleClose} size="small" aria-label="Close">
            <X size={18} />
          </IconButton>
        </div>

        {/* Search */}
        <div className="px-6 pb-3">
          <TextField
            placeholder="Search icons..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
            fullWidth
            size="small"
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <Search size={16} />
                  </InputAdornment>
                ),
              },
            }}
          />
        </div>

        {/* Icon grid */}
        <div ref={scrollRef} className="overflow-y-auto h-80 ml-4 mr-2 mb-4 pl-2 pr-2 py-2 rounded-l-xl rounded-r-none !bg-[var(--mui-palette-background-level1)] themed-scrollbar">
          {filteredIcons.length === 0 ? (
            <p className="text-center py-4 text-sm opacity-70">No icons found for &quot;{search}&quot;</p>
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
                    <IconRow slugs={row} currentIcon={currentIcon} onSelect={handleSelect} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </BottomDrawer>
  );
}
