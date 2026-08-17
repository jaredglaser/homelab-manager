import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogBody, DialogFooter } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { FINDING_SEVERITIES } from '@/lib/findings/types';
import type { FindingSeverity } from '@/lib/findings/types';
import type { ReportMissInput, ReportMissResult } from '@/data/feedback/handlers';

const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_WHAT_HAPPENED_CHARS = 4000;

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  info: 'Info',
  warning: 'Warning',
  critical: 'Critical',
};

const ATTRIBUTION_HEADLINE: Record<string, string> = {
  nothing_recorded: 'Nothing was recorded in this window.',
  counted_only: 'Counted only, never parsed.',
  batched_only: 'Routed to the digest.',
  dispatched_no_finding: 'The agent looked and concluded nothing.',
  dispatch_dropped: 'The signal fired and the dispatch never left.',
  finding_exists: 'A finding already covers this window.',
};

export interface ReportIncidentDialogEntity {
  entityId: string;
  label: string;
  host: string;
}

export interface ReportIncidentDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: ReportMissInput) => void;
  result: ReportMissResult | null;
  onSetStatus: (status: 'accepted' | 'explained') => void;
  isLoading: boolean;
  entities: readonly ReportIncidentDialogEntity[];
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function toLocalInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function parseLocalInputValue(value: string): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function lastNightWindow(now: Date): { from: Date; to: Date } {
  const to = new Date(now);
  to.setHours(6, 0, 0, 0);
  if (to.getTime() > now.getTime()) to.setDate(to.getDate() - 1);
  const from = new Date(to);
  from.setDate(from.getDate() - 1);
  from.setHours(22, 0, 0, 0);
  return { from, to };
}

export default function ReportIncidentDialog({
  open,
  onClose,
  onSubmit,
  result,
  onSetStatus,
  isLoading,
  entities,
}: Readonly<ReportIncidentDialogProps>) {
  const [windowFromInput, setWindowFromInput] = useState('');
  const [windowToInput, setWindowToInput] = useState('');
  const [selectedEntities, setSelectedEntities] = useState<Set<string>>(new Set());
  const [whatHappened, setWhatHappened] = useState('');
  const [severity, setSeverity] = useState<FindingSeverity>('warning');
  const [auditExpanded, setAuditExpanded] = useState(false);

  useEffect(() => {
    if (!open) return;
    const now = new Date();
    setWindowFromInput(toLocalInputValue(new Date(now.getTime() - 2 * 60 * 60 * 1000)));
    setWindowToInput(toLocalInputValue(now));
    setSelectedEntities(new Set());
    setWhatHappened('');
    setSeverity('warning');
    setAuditExpanded(false);
  }, [open]);

  const groupedEntities = useMemo(() => {
    const byHost = new Map<string, ReportIncidentDialogEntity[]>();
    for (const entity of entities) {
      const list = byHost.get(entity.host) ?? [];
      list.push(entity);
      byHost.set(entity.host, list);
    }
    return [...byHost.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [entities]);

  function applyPreset(preset: 'last-hour' | 'last-4-hours' | 'last-night') {
    const now = new Date();
    if (preset === 'last-hour') {
      setWindowFromInput(toLocalInputValue(new Date(now.getTime() - 60 * 60 * 1000)));
      setWindowToInput(toLocalInputValue(now));
    } else if (preset === 'last-4-hours') {
      setWindowFromInput(toLocalInputValue(new Date(now.getTime() - 4 * 60 * 60 * 1000)));
      setWindowToInput(toLocalInputValue(now));
    } else {
      const { from, to } = lastNightWindow(now);
      setWindowFromInput(toLocalInputValue(from));
      setWindowToInput(toLocalInputValue(to));
    }
  }

  function toggleEntity(entityId: string) {
    setSelectedEntities((prev) => {
      const next = new Set(prev);
      if (next.has(entityId)) next.delete(entityId);
      else next.add(entityId);
      return next;
    });
  }

  function handleClose() {
    onClose();
  }

  const fromDate = parseLocalInputValue(windowFromInput);
  const toDate = parseLocalInputValue(windowToInput);
  const windowValid =
    fromDate !== null &&
    toDate !== null &&
    fromDate.getTime() < toDate.getTime() &&
    toDate.getTime() - fromDate.getTime() <= MAX_WINDOW_MS;
  const trimmedWhatHappened = whatHappened.trim();
  const whatHappenedValid = trimmedWhatHappened.length > 0 && trimmedWhatHappened.length <= MAX_WHAT_HAPPENED_CHARS;
  const entitiesValid = selectedEntities.size > 0;
  const canSubmit = windowValid && whatHappenedValid && entitiesValid && !isLoading;

  function handleSubmit() {
    if (!canSubmit || !fromDate || !toDate) return;
    onSubmit({
      windowFrom: fromDate,
      windowTo: toDate,
      entityIds: [...selectedEntities],
      whatHappened: trimmedWhatHappened,
      severity,
    });
  }

  const attribution = result?.attribution ?? null;
  const headline = attribution ? (ATTRIBUTION_HEADLINE[attribution.verdict] ?? attribution.verdict) : null;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) handleClose(); }}>
      <DialogContent>
        <DialogTitle>Report an incident</DialogTitle>
        <DialogBody>
          {result === null ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label>Window</Label>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => applyPreset('last-hour')}>
                    Last hour
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => applyPreset('last-4-hours')}>
                    Last 4 hours
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => applyPreset('last-night')}>
                    Last night (22:00-06:00)
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  <input
                    type="datetime-local"
                    aria-label="Window from"
                    value={windowFromInput}
                    onChange={(event) => setWindowFromInput(event.target.value)}
                    className="h-10 rounded-lg border border-foreground/25 bg-transparent px-3 py-1 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                  />
                  <input
                    type="datetime-local"
                    aria-label="Window to"
                    value={windowToInput}
                    onChange={(event) => setWindowToInput(event.target.value)}
                    className="h-10 rounded-lg border border-foreground/25 bg-transparent px-3 py-1 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                  />
                </div>
                {!windowValid && (windowFromInput || windowToInput) && (
                  <p className="text-xs text-destructive">The window must be ordered and no more than 7 days.</p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Entities</Label>
                {groupedEntities.length === 0 && (
                  <p className="text-xs text-muted-foreground">No containers in the inventory yet.</p>
                )}
                <div className="flex max-h-40 flex-col gap-2 overflow-y-auto themed-scrollbar">
                  {groupedEntities.map(([host, hostEntities]) => (
                    <div key={host} className="flex flex-col gap-1">
                      <span className="text-xs font-medium text-muted-foreground">{host}</span>
                      {hostEntities.map((entity) => (
                        <div key={entity.entityId} className="flex items-center gap-2 pl-2">
                          <Checkbox
                            id={`miss-entity-${entity.entityId}`}
                            checked={selectedEntities.has(entity.entityId)}
                            onCheckedChange={() => toggleEntity(entity.entityId)}
                          />
                          <Label htmlFor={`miss-entity-${entity.entityId}`} className="cursor-pointer text-sm">
                            {entity.label}
                          </Label>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="miss-what-happened">What happened</Label>
                <textarea
                  id="miss-what-happened"
                  value={whatHappened}
                  onChange={(event) => setWhatHappened(event.target.value)}
                  rows={4}
                  maxLength={MAX_WHAT_HAPPENED_CHARS}
                  placeholder="This broke at 21:40 and nothing was said."
                  className="w-full rounded-lg border border-foreground/25 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Severity</Label>
                <ToggleGroup
                  value={[severity]}
                  onValueChange={(value: string[]) => {
                    const next = value[0];
                    if (next === 'info' || next === 'warning' || next === 'critical') setSeverity(next);
                  }}
                >
                  {FINDING_SEVERITIES.map((option) => (
                    <ToggleGroupItem key={option} value={option}>
                      {SEVERITY_LABEL[option]}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {attribution ? (
                <>
                  <p className="text-sm font-medium">{headline}</p>
                  <p className="text-xs text-muted-foreground">
                    {attribution.findings.length} finding{attribution.findings.length === 1 ? '' : 's'},{' '}
                    {attribution.incidents.length} incident{attribution.incidents.length === 1 ? '' : 's'},{' '}
                    {attribution.shapes.length} shape{attribution.shapes.length === 1 ? '' : 's'} covered this window.
                  </p>
                  {(attribution.findings.length > 0 || attribution.incidents.length > 0 || attribution.shapes.length > 0) && (
                    <details open={auditExpanded} onToggle={(event) => setAuditExpanded(event.currentTarget.open)}>
                      <summary className="cursor-pointer text-xs text-primary">View full audit</summary>
                      <pre className="mt-2 max-h-48 overflow-y-auto themed-scrollbar rounded bg-level1 px-2 py-1 text-xs whitespace-pre-wrap break-all">
                        {JSON.stringify(attribution, null, 2)}
                      </pre>
                    </details>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  The miss was saved. Attribution could not be completed automatically.
                </p>
              )}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          {result === null ? (
            <>
              <Button type="button" variant="ghost" className="text-foreground" onClick={handleClose} disabled={isLoading}>
                Cancel
              </Button>
              <Button type="button" onClick={handleSubmit} disabled={!canSubmit}>
                Submit report
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="ghost" className="text-foreground" onClick={handleClose} disabled={isLoading}>
                Close
              </Button>
              <Button type="button" variant="outline" onClick={() => onSetStatus('explained')} disabled={isLoading}>
                This is explained
              </Button>
              <Button type="button" onClick={() => onSetStatus('accepted')} disabled={isLoading}>
                Accept as a miss
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
