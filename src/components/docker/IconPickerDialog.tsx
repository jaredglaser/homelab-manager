import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogActions,
  Button,
  IconButton,
  TextField,
  InputAdornment,
  Typography,
} from '@mui/material';
import { Search, X } from 'lucide-react';
import { AVAILABLE_ICONS } from '@/lib/utils/icon-resolver';
import { SELECTION_FEEDBACK_MS } from '@/lib/constants/ui-timing';
import IconGrid from '@/components/docker/IconGrid';

interface IconPickerDialogProps {
  open: boolean;
  onClose: () => void;
  onSelect: (iconSlug: string | null) => void;
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
  const [pendingIcon, setPendingIcon] = useState<string | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (open) {
      setPendingIcon(null);
      setSearch('');
    }
    return () => clearTimeout(feedbackTimerRef.current);
  }, [open]);

  const filteredIcons = useMemo(() => {
    if (!search.trim()) return AVAILABLE_ICONS;
    const term = search.toLowerCase();
    return AVAILABLE_ICONS.filter((icon) => icon.includes(term));
  }, [search]);

  const handleTileSelect = useCallback((iconSlug: string) => {
    setPendingIcon(iconSlug);
  }, []);

  const handleApply = useCallback(() => {
    if (pendingIcon) {
      onSelect(pendingIcon);
      clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = setTimeout(() => {
        onClose();
      }, SELECTION_FEEDBACK_MS);
    }
  }, [pendingIcon, onSelect, onClose]);

  const handleAutoDetect = useCallback(() => {
    onSelect(null);
    clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = setTimeout(() => {
      onClose();
    }, SELECTION_FEEDBACK_MS);
  }, [onSelect, onClose]);

  const handleClose = useCallback(() => {
    setSearch('');
    setPendingIcon(null);
    onClose();
  }, [onClose]);

  const displayedIcon = pendingIcon ?? currentIcon;

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="md"
      fullWidth
      slotProps={{
        paper: {
          className: 'rounded-lg! bg-(--mui-palette-background-popup) w-[720px] max-h-[600px]',
        },
      }}
    >
      <div
        className="flex items-center justify-between px-5 pt-3 pb-3 border-b border-(--mui-palette-divider) shrink-0 bg-(--mui-palette-background-popup)"
      >
        <Typography variant="h6" className="text-sm! font-semibold!">
          Select Icon for {containerName}
        </Typography>
        <IconButton onClick={handleClose} size="small" aria-label="Close">
          <X size={18} />
        </IconButton>
      </div>

      <div className="px-5 pt-3 pb-2 shrink-0">
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
              endAdornment: search ? (
                <InputAdornment position="end">
                  <IconButton size="small" onClick={() => setSearch('')} edge="end" aria-label="Clear search">
                    <X size={14} />
                  </IconButton>
                </InputAdornment>
              ) : undefined,
            },
          }}
        />
        <Typography
          variant="caption"
          className="mt-1 block text-(--mui-palette-text-disabled)"
        >
          Showing {filteredIcons.length} of {AVAILABLE_ICONS.length} icons
        </Typography>
      </div>

      <DialogContent className="p-0! flex-1 min-h-0">
        <IconGrid
          filteredIcons={filteredIcons}
          currentIcon={displayedIcon}
          onSelect={handleTileSelect}
          emptyMessage={`No icons found for "${search}"`}
        />
      </DialogContent>

      <DialogActions
        className="px-5 py-3 border-t border-(--mui-palette-divider)! bg-(--mui-palette-background-popup)"
      >
        <Button
          size="small"
          variant="text"
          onClick={handleAutoDetect}
          className="mr-auto! text-xs! text-(--mui-palette-text-secondary)"
        >
          Use auto-detected
        </Button>
        <Button size="small" variant="outlined" onClick={handleClose} className="text-xs!">
          Cancel
        </Button>
        <Button
          size="small"
          variant="contained"
          onClick={handleApply}
          disabled={!pendingIcon}
          className="text-xs!"
        >
          Apply
        </Button>
      </DialogActions>
    </Dialog>
  );
}
