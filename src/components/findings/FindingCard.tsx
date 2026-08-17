import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils/cn';
import type { Finding, FindingSeverity, FindingStatus } from '@/lib/findings/types';
import type { OperatorVerdict, FindingVerdictSummary, WeakSignalSummary } from '@/lib/feedback/types';

const OPERATOR_VERDICT_ORDER: readonly OperatorVerdict[] = ['actionable', 'noise', 'duplicate', 'wrong'];

const VERDICT_LABEL: Record<OperatorVerdict, string> = {
  actionable: 'Actionable',
  noise: 'Noise',
  duplicate: 'Duplicate',
  wrong: 'Wrong',
};

const SIGNAL_LABEL: Record<string, string> = {
  rollback_after: 'rolled back',
  nonzero_exit_after: 'exited non-zero',
  restart_after: 'restarted',
  redeploy_after: 'redeployed',
  quiet_24h: 'stayed healthy and untouched for a day',
  no_outcome_observed: 'no outcome observed',
};

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

function formatWeakSignals(weakSignals: WeakSignalSummary): string {
  const labels = weakSignals.signals.map((signal: string) => SIGNAL_LABEL[signal] ?? signal.replace(/_/g, ' '));
  const base = labels.length > 0 ? labels.join(', ') : 'no signal yet';
  if (weakSignals.confounders.length === 0) return base;
  return `${base} (confounded: ${weakSignals.confounders.join(', ')})`;
}

export interface OnLabelInput {
  verdict: OperatorVerdict;
  note?: string;
  duplicateOfId?: number;
}

interface VerdictBlockProps {
  verdict: FindingVerdictSummary | null;
  weakSignals: WeakSignalSummary | null;
  canLabel: boolean;
  isLabeling: boolean;
  onLabel?: (input: OnLabelInput) => void;
}

function VerdictBlock({ verdict, weakSignals, canLabel, isLabeling, onLabel }: Readonly<VerdictBlockProps>) {
  const [changing, setChanging] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');

  if (!canLabel && !verdict && !weakSignals) return null;

  const canWrite = canLabel && onLabel !== undefined;
  const showButtons = canWrite && (!verdict || verdict.source === 'agent' || changing);

  function pick(next: OperatorVerdict) {
    onLabel?.({ verdict: next, note: note.trim() ? note.trim() : undefined });
    setChanging(false);
    setNoteOpen(false);
    setNote('');
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-2">
      {verdict && !changing && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant={verdict.source === 'agent' ? 'outline' : verdict.verdict === 'actionable' ? 'success' : 'secondary'}>
            {verdict.source === 'agent' ? 'Agent retracted this' : VERDICT_LABEL[verdict.verdict]}
          </Badge>
          <span className="text-muted-foreground">
            {verdict.source === 'agent' ? 'agent' : `changed by ${verdict.labeledBy ?? 'unknown'}`} on {formatDate(verdict.labeledAt)}
          </span>
          {canWrite && verdict.source === 'operator' && (
            <button type="button" className="text-primary hover:underline" onClick={() => setChanging(true)}>
              Change
            </button>
          )}
        </div>
      )}

      {verdict && verdict.relabelCount > 0 && (
        <p className="text-xs text-muted-foreground">
          Relabelled {verdict.relabelCount === 1 ? 'once' : `${verdict.relabelCount} times`}, most recently{' '}
          {VERDICT_LABEL[verdict.verdict].toLowerCase()} on {formatDate(verdict.labeledAt)}.
        </p>
      )}

      {showButtons && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {OPERATOR_VERDICT_ORDER.map((option) => (
              <Button key={option} type="button" variant="outline" size="sm" disabled={isLabeling} onClick={() => pick(option)}>
                {VERDICT_LABEL[option]}
              </Button>
            ))}
          </div>
          {noteOpen ? (
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Optional note"
              rows={2}
              maxLength={1000}
              className="w-full rounded-lg border border-foreground/25 bg-transparent px-2 py-1 text-xs outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary"
            />
          ) : (
            <button type="button" className="self-start text-xs text-primary hover:underline" onClick={() => setNoteOpen(true)}>
              Add note
            </button>
          )}
        </div>
      )}

      {weakSignals && weakSignals.signalCount > 0 && (
        <p className="text-xs text-muted-foreground">Weak signals: {formatWeakSignals(weakSignals)}</p>
      )}
    </div>
  );
}

export interface FindingCardProps {
  finding: Finding;
  verdict?: FindingVerdictSummary | null;
  weakSignals?: WeakSignalSummary | null;
  canLabel?: boolean;
  isLabeling?: boolean;
  onLabel?: (input: OnLabelInput) => void;
  defaultExpanded?: boolean;
}

export function FindingCard({
  finding,
  verdict = null,
  weakSignals = null,
  canLabel = false,
  isLabeling = false,
  onLabel,
  defaultExpanded = false,
}: Readonly<FindingCardProps>) {
  const [expanded, setExpanded] = useState(defaultExpanded);
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
          <VerdictBlock verdict={verdict} weakSignals={weakSignals} canLabel={canLabel} isLabeling={isLabeling} onLabel={onLabel} />
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
