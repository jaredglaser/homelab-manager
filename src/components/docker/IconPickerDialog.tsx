import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { IconButton, TextField, InputAdornment, Typography } from '@mui/material';
import { Search, X } from 'lucide-react';
import { AVAILABLE_ICONS } from '@/lib/utils/icon-resolver';
import { SELECTION_FEEDBACK_MS } from '@/lib/constants/ui-timing';
import BottomDrawer from '@/components/shared/BottomDrawer';
import IconGrid from '@/components/docker/IconGrid';

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
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => clearTimeout(feedbackTimerRef.current);
  }, []);

  const filteredIcons = useMemo(() => {
    if (!search.trim()) return AVAILABLE_ICONS;
    const term = search.toLowerCase();
    return AVAILABLE_ICONS.filter((icon) => icon.includes(term));
  }, [search]);

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
        <div className="flex items-center justify-between px-6 pt-2 pb-3 select-none">
          <Typography variant="h6">Select Icon for {containerName}</Typography>
          <IconButton onClick={handleClose} size="small" aria-label="Close">
            <X size={18} />
          </IconButton>
        </div>

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

        <IconGrid
          filteredIcons={filteredIcons}
          currentIcon={currentIcon}
          onSelect={handleSelect}
          emptyMessage={`No icons found for "${search}"`}
        />
      </div>
    </BottomDrawer>
  );
}
