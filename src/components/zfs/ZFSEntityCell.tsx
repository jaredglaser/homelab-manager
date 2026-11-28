import { memo, type ReactElement } from 'react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ChevronRight, Server } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { ZFSHealthTone } from '@/components/zfs/utils/zfs-row-builders';

const TONE_VARIANTS = { ok: 'outline', warning: 'warning', error: 'destructive' } as const satisfies Record<ZFSHealthTone, string>;

interface ZFSEntityCellProps {
  name: string;
  entityType: 'host' | 'pool' | 'group' | 'vdev' | 'disk';
  indent: number;
  isExpanded?: boolean;
  canExpand?: boolean;
  badge?: { label: string; tooltip?: string };
  health?: { label: string; tone: ZFSHealthTone; tooltip?: string };
  detail?: string;
}

function WithTooltip({ chip, tooltip }: Readonly<{ chip: ReactElement; tooltip?: string }>) {
  if (!tooltip) return chip;
  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
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
  health,
  detail,
}: Readonly<ZFSEntityCellProps>) {
  const isBold = entityType === 'host' || entityType === 'pool';


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
      <span className={cn('truncate', isBold ? 'font-bold' : 'text-sm', entityType === 'group' && 'text-muted-foreground')}>{name}</span>
      {health && <WithTooltip chip={<Badge variant={TONE_VARIANTS[health.tone]}>{health.label}</Badge>} tooltip={health.tooltip} />}
      {badge && <WithTooltip chip={<Badge variant="secondary">{badge.label}</Badge>} tooltip={badge.tooltip} />}
      {detail && <span className="truncate text-xs text-muted-foreground" title={detail}>{detail}</span>}
    </div>
  );
});

export default ZFSEntityCell;
