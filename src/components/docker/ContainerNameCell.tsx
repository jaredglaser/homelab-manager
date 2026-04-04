import { memo } from 'react';
import { ChevronRight, History, Settings } from 'lucide-react';
import type { DockerStatsFromDB } from '@/types/docker';
import { FALLBACK_ICON_URL } from '@/lib/utils/icon-resolver';

interface ContainerNameCellProps {
  container: DockerStatsFromDB;
  expanded: boolean;
  indicatorRef: React.RefObject<HTMLDivElement | null>;
  pingRef: React.RefObject<HTMLDivElement | null>;
  dotRef: React.RefObject<HTMLDivElement | null>;
  lastUpdated: Date | undefined;
  iconUrl: string;
  iconError: boolean;
  onIconError: () => void;
  onOpenIconPicker: () => void;
  onOpenHistory?: (containerId: string, host: string) => void;
}

export const ContainerNameCell = memo(function ContainerNameCell({
  container,
  expanded,
  indicatorRef,
  pingRef,
  dotRef,
  lastUpdated,
  iconUrl,
  iconError,
  onIconError,
  onOpenIconPicker,
  onOpenHistory,
}: ContainerNameCellProps) {
  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-2">
        <ChevronRight
          size={16}
          className={`transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
        />

        {/* Container update indicator - pulses when stats update */}
        <div
          ref={indicatorRef}
          className="relative w-2 h-2 flex-shrink-0"
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

        <img
          src={iconError ? FALLBACK_ICON_URL : iconUrl}
          alt=""
          className="w-5 h-5 flex-shrink-0"
          onError={onIconError}
        />
        <span className="truncate">{container.name}</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenIconPicker();
          }}
          className={`p-1 rounded-full transition-opacity hover:bg-black/10 dark:hover:bg-white/10 ${expanded ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}
          aria-label="Change container icon"
          tabIndex={expanded ? 0 : -1}
          aria-hidden={!expanded}
        >
          <Settings size={14} />
        </button>
        {onOpenHistory && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenHistory(container.id.split('/')[1], container.id.split('/')[0]);
            }}
            className={`p-1 rounded-full transition-opacity hover:bg-black/10 dark:hover:bg-white/10 ${expanded ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}
            aria-label="View container history"
            tabIndex={expanded ? 0 : -1}
            aria-hidden={!expanded}
          >
            <History size={14} />
          </button>
        )}
      </div>
    </div>
  );
});
