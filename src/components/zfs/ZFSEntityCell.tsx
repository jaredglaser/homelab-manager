import { memo } from 'react';
import { Chip, Tooltip } from '@mui/material';
import { ChevronRight, Server } from 'lucide-react';

interface ZFSEntityCellProps {
  name: string;
  entityType: 'host' | 'pool' | 'vdev' | 'disk';
  indent: number;
  isExpanded?: boolean;
  canExpand?: boolean;
  onToggle?: () => void;
  badge?: { label: string; tooltip?: string };
}

/**
 * Name cell for ZFS table rows. Renders indent padding, an optional expand
 * chevron, the entity name (bold for hosts/pools), and an optional chip badge.
 */
const ZFSEntityCell = memo(function ZFSEntityCell({
  name,
  entityType,
  indent,
  isExpanded,
  canExpand,
  onToggle,
  badge,
}: Readonly<ZFSEntityCellProps>) {
  const isBold = entityType === 'host' || entityType === 'pool';

  const chipEl = badge ? (
    <Chip size="small" variant="filled" label={badge.label} />
  ) : null;

  return (
    <div
      role={canExpand ? 'button' : undefined}
      tabIndex={canExpand ? 0 : undefined}
      onClick={canExpand ? onToggle : undefined}
      onKeyDown={
        canExpand
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onToggle?.();
              }
            }
          : undefined
      }
      className={`flex items-center gap-2 min-w-0 ${canExpand ? 'cursor-pointer' : 'cursor-default'}`}
      style={indent > 0 ? { paddingLeft: indent * 16 } : undefined}
    >
      {canExpand && (
        <ChevronRight
          size={entityType === 'host' ? 18 : 16}
          className={`flex-shrink-0 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
        />
      )}
      {entityType === 'host' && <Server size={18} />}
      <span className={`truncate ${isBold ? 'font-bold' : 'text-sm'}`}>{name}</span>
      {badge?.tooltip ? (
        <Tooltip title={badge.tooltip} arrow placement="bottom-end">
          {chipEl!}
        </Tooltip>
      ) : (
        chipEl
      )}
    </div>
  );
});

export default ZFSEntityCell;
