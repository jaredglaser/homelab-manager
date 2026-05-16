import { useEffect, useState } from 'react';
import { IconButton } from '@mui/material';
import { ChevronRight, History, Settings } from 'lucide-react';
import { useToast } from '@/hooks/toastAtom';
import { getIconUrl, FALLBACK_ICON_URL } from '@/lib/utils/icon-resolver';
import IconPickerDialog from '@/components/docker/IconPickerDialog';
import ContainerStateChip from '@/components/docker/ContainerStateChip';
import { usePulseIndicator } from '@/hooks/usePulseIndicator';
import type { DockerContainerTableRow } from '@/types/docker';

/**
 * Name cell for container rows: shows icon, pulse indicator, state chip, name,
 * settings and history buttons. Uses hooks for pulse animation and icon picker.
 */
function ContainerNameCell({
  row,
  expanded,
  onIconChange,
  onOpenHistory,
}: Readonly<{
  row: DockerContainerTableRow;
  expanded: boolean;
  onIconChange: (serviceKeyEntity: string, iconSlug: string) => Promise<void>;
  onOpenHistory?: (containerId: string, host: string) => void;
}>) {
  const { inventory, stats } = row;

  const { showToast } = useToast();
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [iconError, setIconError] = useState(false);

  const iconUrl = getIconUrl(stats?.icon ?? null, inventory.image);

  useEffect(() => {
    setIconError(false);
  }, [iconUrl]);

  const lastChartRow = row.chartData?.at(-1);
  const lastUpdated = lastChartRow ? new Date(lastChartRow.time) : undefined;
  const lastUpdatedMs = lastUpdated?.getTime() ?? 0;
  const { indicatorRef, pingRef, dotRef } = usePulseIndicator(lastUpdatedMs);

  const handleIconSelect = async (iconSlug: string | null) => {
    if (iconSlug === null) return; // null means use auto-detected — no stored preference to save
    try {
      const serviceKeyEntity = stats?.serviceKeyEntity ?? `${inventory.host}/${inventory.name}`;
      await onIconChange(serviceKeyEntity, iconSlug);
    } catch (err) {
      console.error('Failed to update container icon:', err);
      showToast('Failed to update icon. Please try again.', 'error');
    }
  };

  const handleHistoryClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const { host, containerId } = inventory;
    if (host && containerId && onOpenHistory) onOpenHistory(containerId, host);
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <ChevronRight
          size={16}
          className={`shrink-0 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
        />

        {/* Pulse indicator: for running and restarting containers with data */}
        {(inventory.state === 'running' || inventory.state === 'restarting') && (
          <div
            ref={indicatorRef}
            className="relative w-2 h-2 shrink-0"
            title={lastUpdated ? `Last updated: ${lastUpdated.toLocaleTimeString()}` : 'No data yet'}
          >
            <div
              ref={pingRef}
              className="absolute inset-0 rounded-full transition-opacity duration-200 opacity-0"
              style={{ backgroundColor: 'var(--indicator-active)' }}
            />
            <div
              ref={dotRef}
              className="absolute inset-0 rounded-full transition-colors duration-300"
              style={{ backgroundColor: 'var(--indicator-active)' }}
            />
          </div>
        )}
        {inventory.state !== 'running' && (
          <ContainerStateChip state={inventory.state} />
        )}

        <img
          src={iconError ? FALLBACK_ICON_URL : iconUrl}
          alt=""
          className="w-5 h-5 shrink-0"
          onError={() => setIconError(true)}
        />
        <span className="truncate">{inventory.name}</span>
        <IconButton
          size="small"
          onClick={(e) => {
            e.stopPropagation();
            setIconPickerOpen(true);
          }}
          className={`p-1! transition-opacity ${expanded ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}
          aria-label="Change container icon"
          tabIndex={expanded ? 0 : -1}
          aria-hidden={!expanded}
        >
          <Settings size={14} />
        </IconButton>
        {onOpenHistory && (
          <IconButton
            size="small"
            onClick={handleHistoryClick}
            className={`p-1! transition-opacity ${expanded ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}
            aria-label="View container history"
            tabIndex={expanded ? 0 : -1}
            aria-hidden={!expanded}
          >
            <History size={14} />
          </IconButton>
        )}
      </div>

      {iconPickerOpen && (
        <IconPickerDialog
          open={iconPickerOpen}
          onClose={() => setIconPickerOpen(false)}
          onSelect={handleIconSelect}
          currentIcon={stats?.icon ?? null}
          containerName={inventory.name}
        />
      )}
    </>
  );
}

export default ContainerNameCell;
