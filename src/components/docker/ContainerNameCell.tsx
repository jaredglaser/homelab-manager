import { memo, useState } from 'react';
import { ChevronRight, History, Settings } from 'lucide-react';
import type { DockerStatsFromDB } from '@/types/docker';
import { getIconUrl, FALLBACK_ICON_URL } from '@/lib/utils/icon-resolver';

interface ContainerNameCellProps {
  container: DockerStatsFromDB;
  expanded: boolean;
  indicatorRef: React.RefObject<HTMLDivElement | null>;
  pingRef: React.RefObject<HTMLDivElement | null>;
  dotRef: React.RefObject<HTMLDivElement | null>;
  lastUpdated: Date | undefined;
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
  onOpenIconPicker,
  onOpenHistory,
}: ContainerNameCellProps) {
  const [iconError, setIconError] = useState(false);
  const iconUrl = getIconUrl(container.icon, container.image);

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
          onError={() => setIconError(true)}
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
              const slash = container.id.indexOf('/');
              if (slash !== -1) {
                onOpenHistory(container.id.slice(slash + 1), container.id.slice(0, slash));
              }
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
