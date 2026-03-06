import { memo, useState, useMemo, useRef, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Drawer, IconButton, TextField, InputAdornment, Typography, Skeleton } from '@mui/material';
import { Search, X } from 'lucide-react';
import { AVAILABLE_ICONS } from '@/lib/utils/icon-resolver';

const IconCell = memo(function IconCell({ slug, selected, onSelect }: { slug: string; selected: boolean; onSelect: (slug: string) => void }) {
  const [loaded, setLoaded] = useState(false);
  const handleLoad = useCallback(() => setLoaded(true), []);

  return (
    <button
      type="button"
      onClick={() => onSelect(slug)}
      className={`flex flex-col items-center p-2 rounded-md hover:bg-blue-500/10 ${
        selected ? 'bg-blue-500/20 ring-1 ring-blue-500' : ''
      }`}
    >
      <div className="relative w-8 h-8">
        {!loaded && (
          <Skeleton variant="rounded" width={32} height={32} className="!absolute inset-0" />
        )}
        <img
          src={`${import.meta.env.BASE_URL}icons/${slug}.svg`}
          alt={slug}
          className={`w-8 h-8 ${loaded ? 'visible' : 'invisible'}`}
          onLoad={handleLoad}
        />
      </div>
      <span className="mt-1 text-xs truncate w-full text-center">{slug}</span>
    </button>
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

  const handleSelect = (iconSlug: string) => {
    onSelect(iconSlug);
    onClose();
    setSearch('');
  };

  const handleClose = () => {
    onClose();
    setSearch('');
  };

  return (
    <Drawer
      anchor="bottom"
      open={open}
      onClose={handleClose}
      transitionDuration={{ enter: 400, exit: 300 }}
      slotProps={{
        paper: {
          className:
            '!rounded-t-2xl !rounded-b-none !bg-[var(--mui-palette-background-default)] !max-h-[calc(100vh-60px)]',
        },
        transition: {
          easing: {
            enter: 'cubic-bezier(0.32, 0.72, 0, 1)',
            exit: 'cubic-bezier(0.32, 0.72, 0, 1)',
          },
        },
      }}
    >
      {/* Drag handle */}
      <div className="flex justify-center pt-3 pb-1 select-none">
        <div className="w-10 h-1 rounded-full bg-neutral-400/50" />
      </div>

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
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative', contain: 'strict' }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const row = iconRows[virtualRow.index];
                return (
                  <div
                    key={virtualRow.index}
                    className="grid grid-cols-7 gap-2 absolute left-0 w-full"
                    style={{
                      height: virtualRow.size,
                      transform: `translateY(${virtualRow.start}px)`,
                      willChange: 'transform',
                    }}
                  >
                    {row.map((slug) => (
                      <IconCell key={slug} slug={slug} selected={currentIcon === slug} onSelect={handleSelect} />
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Drawer>
  );
}
