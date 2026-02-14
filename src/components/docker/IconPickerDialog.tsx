import { useState, useMemo } from 'react';
import { Modal, ModalDialog, ModalClose, DialogTitle, DialogContent, Input } from '@mui/joy';
import { Search } from 'lucide-react';
import { AVAILABLE_ICONS } from '@/lib/utils/icon-resolver';

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

  // Filter icons based on search
  const filteredIcons = useMemo(() => {
    if (!search.trim()) return AVAILABLE_ICONS;
    const term = search.toLowerCase();
    return AVAILABLE_ICONS.filter((icon) => icon.includes(term));
  }, [search]);

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
        sx={{ width: 'min(90vw, 40rem)' }}
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
          <div className="max-h-80 overflow-y-auto">
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(4.5rem, 1fr))' }}>
              {filteredIcons.map((slug) => (
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
            {filteredIcons.length === 0 && (
              <p className="text-center py-4 text-sm opacity-70">No icons found for "{search}"</p>
            )}
          </div>
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
}
