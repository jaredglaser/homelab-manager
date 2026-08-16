import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils/cn';
import type { Finding, FindingSeverity, FindingStatus } from '@/lib/findings/types';

const SEVERITY_BADGE_VARIANT: Record<FindingSeverity, 'destructive' | 'warning' | 'secondary'> = {
  critical: 'destructive',
  warning: 'warning',
  info: 'secondary',
};

const SEVERITY_ACCENT_CLASS: Record<FindingSeverity, string> = {
  critical: 'border-l-2 border-destructive',
  warning: 'border-l-2 border-warning',
  info: 'border-l-2 border-border',
};

const STATUS_LABEL: Record<Extract<FindingStatus, 'resolved' | 'dismissed'>, string> = {
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};

function formatDate(date: Date): string {
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

function subjectLine(finding: Finding): string | null {
  if (finding.subjectKind !== 'container') return null;
  const stackEntity = finding.entityIds.find((id) => id !== finding.subjectId);
  return stackEntity ?? null;
}

export interface FindingCardProps {
  finding: Finding;
}

export function FindingCard({ finding }: Readonly<FindingCardProps>) {
  const [expanded, setExpanded] = useState(false);
  const isClosed = finding.status !== 'open';
  const relatedSubject = subjectLine(finding);

  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className={cn(
        'bg-card border border-border rounded-lg',
        SEVERITY_ACCENT_CLASS[finding.severity],
        isClosed && 'opacity-70',
      )}
    >
      <CollapsibleTrigger className="w-full text-left px-3 py-2 cursor-pointer hover:bg-accent rounded-lg">
        <div className="flex items-center gap-2 text-sm">
          <Badge variant={SEVERITY_BADGE_VARIANT[finding.severity]} className="h-5 shrink-0">
            {finding.severity}
          </Badge>
          <span className="font-medium truncate">{finding.title}</span>
          {finding.occurrences > 1 && (
            <span className="text-xs text-muted-foreground shrink-0">×{finding.occurrences}</span>
          )}
          {finding.status !== 'open' && (
            <Badge variant="outline" className="h-5 shrink-0 text-muted-foreground">
              {STATUS_LABEL[finding.status as Extract<FindingStatus, 'resolved' | 'dismissed'>]}
            </Badge>
          )}
          <span className="ml-auto shrink-0 text-xs whitespace-nowrap text-muted-foreground">
            {formatDate(finding.lastSeenAt)}
          </span>
          <ChevronRight
            size={14}
            className={cn('transition-transform duration-200 shrink-0', expanded && 'rotate-90')}
          />
        </div>
        <div className="mt-0.5 flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <span className="truncate">{finding.subjectId}</span>
          {relatedSubject && <span className="truncate">· {relatedSubject}</span>}
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-3 pb-3 pt-1 flex flex-col gap-3">
          {finding.detail && (
            <p className="text-sm whitespace-pre-wrap">{finding.detail}</p>
          )}
          {(finding.windowFrom || finding.windowTo) && (
            <p className="text-xs text-muted-foreground">
              Window: {finding.windowFrom ? formatDate(finding.windowFrom) : '…'}
              {' → '}
              {finding.windowTo ? formatDate(finding.windowTo) : '…'}
            </p>
          )}
          {finding.evidence.length > 0 && (
            <ul className="flex flex-col gap-2">
              {finding.evidence.map((item, index) => (
                <li key={`${item.kind}-${index}`} className="flex flex-col gap-1">
                  <div className="text-xs text-muted-foreground">
                    {item.kind}
                    {item.source && ` · ${item.source}`}
                    {item.at && ` · ${formatDate(item.at)}`}
                  </div>
                  <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-level1 rounded px-2 py-1">
                    {item.text}
                    {item.truncated && ' … (truncated)'}
                  </pre>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="font-mono">{finding.fingerprint}</span>
            <span>first seen {formatDate(finding.firstSeenAt)}</span>
            <span>{finding.occurrences} occurrence{finding.occurrences === 1 ? '' : 's'}</span>
            {finding.incidentIds.length > 0 && (
              <span>incidents: {finding.incidentIds.join(', ')}</span>
            )}
          </div>
          {finding.status !== 'open' && finding.resolution && (
            <p className="text-xs text-muted-foreground">
              {STATUS_LABEL[finding.status as Extract<FindingStatus, 'resolved' | 'dismissed'>]}
              {finding.resolvedAt && ` ${formatDate(finding.resolvedAt)}`}: {finding.resolution}
            </p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
