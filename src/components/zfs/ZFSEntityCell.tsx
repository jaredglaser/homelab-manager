import { memo } from 'react';
import { Badge } from '@/components/ui/badge';
import TapTooltip from '@/components/ui/tap-tooltip';
import { ChevronRight, Server } from 'lucide-react';

interface ZFSEntityCellProps {
  name: string;
  entityType: 'host' | 'pool' | 'vdev' | 'disk';
  indent: number;
  isExpanded?: boolean;
  canExpand?: boolean;
  badge?: { label: string; tooltip?: string };
}

/**
 * Name cell for ZFS table rows. Renders an optional expand
 * chevron, the entity name (bold for hosts/pools), and an optional chip badge.
 */
const ZFSEntityCell = memo(function ZFSEntityCell({
  name,
  entityType,
  indent,
  isExpanded,
  canExpand,
  badge,
}: Readonly<ZFSEntityCellProps>) {
  const isBold = entityType === 'host' || entityType === 'pool';

  const chipEl = badge ? (
    <Badge
      variant="secondary"
      aria-label={badge.tooltip ? `${badge.label}: ${badge.tooltip}` : undefined}
    >
      {badge.label}
    </Badge>
  ) : null;

  return (
    <div
      className="flex items-center gap-2 min-w-0"
      style={indent > 0 ? { paddingLeft: indent * 16 } : undefined}
    >
      {canExpand && (
        <ChevronRight
          size={entityType === 'host' ? 18 : 16}
          className={`shrink-0 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
        />
      )}
      {entityType === 'host' && <Server size={18} />}
      <span className={`truncate ${isBold ? 'font-bold' : 'text-sm'}`}>{name}</span>
      {badge?.tooltip ? (
        <TapTooltip content={badge.tooltip} className="inline-flex tap-target">
          {chipEl}
        </TapTooltip>
      ) : (
        chipEl
      )}
    </div>
  );
});

export default ZFSEntityCell;
