import { useState, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Modal, ModalDialog, ModalClose, DialogTitle, DialogContent, Input } from '@mui/joy';
import { Search } from 'lucide-react';
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
    <Modal open={open} onClose={handleClose}>
      <ModalDialog
        aria-labelledby="icon-picker-title"
        className="!w-[min(90vw,40rem)]"
      >
        <ModalClose />
        <DialogTitle id="icon-picker-title">Select Icon for {containerName}</DialogTitle>
        <DialogContent>
          <Input
            placeholder="Search icons..."
            startDecorator={<Search size={16} />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="mb-4"
            autoFocus
          />
          <div ref={scrollRef} className="max-h-80 overflow-y-auto">
            {filteredIcons.length === 0 ? (
              <p className="text-center py-4 text-sm opacity-70">No icons found for &quot;{search}&quot;</p>
            ) : (
              <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
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
      </ModalDialog>
    </Modal>
  );
}
