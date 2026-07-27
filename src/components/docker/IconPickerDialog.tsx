import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Search, X } from 'lucide-react';
import { AVAILABLE_ICONS } from '@/lib/utils/icon-resolver';
import { SELECTION_FEEDBACK_MS } from '@/lib/constants/ui-timing';
import { useIsTouch } from '@/hooks/useMediaQuery';
import { cn } from '@/lib/utils/cn';
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
  const isTouch = useIsTouch();

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
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) handleClose(); }}>
      <DialogContent className="flex flex-col overflow-hidden rounded-lg bg-(--popover) w-[calc(100%-32px)] max-w-[calc(100%-32px)] sm:w-[720px] sm:max-w-[calc(100%-64px)] max-h-[600px] p-0">
        <div className="flex items-center justify-between px-5 pt-3 pb-3 border-b border-(--border) shrink-0 bg-(--popover)">
          <h2 className="text-sm font-semibold">
            Select Icon for {containerName}
          </h2>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleClose}
            aria-label="Close"
            className={cn(isTouch && 'tap-target')}
          >
            <X size={18} />
          </Button>
        </div>

        <div className="px-5 pt-3 pb-2 shrink-0">
          <div className="relative">
            <Search size={16} className="absolute left-2.5 top-1/2 -translate-y-1/2 opacity-60 pointer-events-none" />
            <Input
              placeholder="Search icons..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
              className="h-9 pl-8 pr-9"
            />
            {search && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setSearch('')}
                aria-label="Clear search"
                className="absolute right-1 top-1/2 -translate-y-1/2"
              >
                <X size={14} />
              </Button>
            )}
          </div>
          <span className="mt-1 block text-xs text-(--text-disabled)">
            Showing {filteredIcons.length} of {AVAILABLE_ICONS.length} icons
          </span>
        </div>

        <div className="flex-1 min-h-0">
          <IconGrid
            filteredIcons={filteredIcons}
            currentIcon={displayedIcon}
            onSelect={handleTileSelect}
            emptyMessage={`No icons found for "${search}"`}
          />
        </div>

        <DialogFooter className="flex-wrap justify-between px-5 py-3 border-t border-(--border) bg-(--popover)">
          <Button
            size="sm"
            variant="ghost"
            onClick={handleAutoDetect}
            className={cn('text-xs text-(--muted-foreground)', isTouch && 'tap-target')}
          >
            Use auto-detected
          </Button>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={handleClose}
              className={cn('text-xs', isTouch && 'tap-target')}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleApply}
              disabled={!pendingIcon}
              className={cn('text-xs', isTouch && 'tap-target')}
            >
              Apply
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
