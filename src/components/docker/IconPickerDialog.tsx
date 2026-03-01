import { useState, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Dialog, DialogTitle, DialogContent, IconButton, TextField, InputAdornment } from '@mui/material';
import { Search, X } from 'lucide-react';
import { AVAILABLE_ICONS } from '@/lib/utils/icon-resolver';

const ICON_COLS = 7;
const ICON_ROW_HEIGHT = 76;

interface IconPickerDialogProps {
  open: boolean;
  onClose: () => void;
  onSelect: (iconSlug: string) => void;
  currentIcon: string | null;
  containerName: string;
}

/**
 * Render a searchable, virtualized dialog for selecting an icon.
 *
 * Displays a TextField to filter available icons and a virtualized grid organized
 * into rows of seven icons. Selecting an icon calls `onSelect`, closes the dialog,
 * and clears the search; closing the dialog also clears the search.
 *
 * @param open - Whether the dialog is open
 * @param onClose - Callback invoked when the dialog should close
 * @param onSelect - Callback invoked with the selected icon slug
 * @param currentIcon - The currently selected icon slug, which will be highlighted if present
 * @param containerName - Human-readable name inserted into the dialog title
 * @returns The dialog element containing the search input and virtualized icon grid
 */
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
    overscan: 3,
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
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
      aria-labelledby="icon-picker-title"
    >
      <DialogTitle id="icon-picker-title" className="flex items-center justify-between">
        Select Icon for {containerName}
        <IconButton onClick={handleClose} size="small" aria-label="Close">
          <X size={18} />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        <TextField
          placeholder="Search icons..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="mb-4"
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
        <div ref={scrollRef} className="max-h-80 overflow-y-auto">
          {filteredIcons.length === 0 ? (
            <p className="text-center py-4 text-sm opacity-70">No icons found for &quot;{search}&quot;</p>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
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
                    {row.map((slug) => (
                      <button
                        key={slug}
                        onClick={() => handleSelect(slug)}
                        className={`flex flex-col items-center p-2 rounded-md transition-colors hover:bg-blue-500/10 ${
                          currentIcon === slug ? 'bg-blue-500/20 ring-1 ring-blue-500' : ''
                        }`}
                      >
                        <img src={`/icons/${slug}.svg`} alt={slug} className="w-8 h-8" />
                        <span className="mt-1 text-xs truncate w-full text-center">{slug}</span>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
