import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import type { AnsibleHostOutcome, AnsibleHostSummary, AnsibleRunStatus } from '@/types/ansible';
import type { AnsibleTaskLine } from '@/hooks/useAnsibleRun';

export interface AutomationPanelProps {
  hosts: string[];
  selectedHosts: string[];
  onToggleHost: (host: string) => void;
  checkMode: boolean;
  onCheckModeChange: (checked: boolean) => void;
  onRun: () => void;
  isRunning: boolean;
  status: AnsibleRunStatus | null;
  lines: AnsibleTaskLine[];
  summaries: AnsibleHostSummary[];
  error: string | null;
}

const OUTCOME_VARIANT: Record<AnsibleHostOutcome, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  ok: 'secondary',
  changed: 'default',
  failed: 'destructive',
  unreachable: 'outline',
};

function SummaryRow({ summary }: Readonly<{ summary: AnsibleHostSummary }>) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-border last:border-b-0">
      <span className="font-mono text-sm">{summary.host}</span>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>ok {summary.ok}</span>
        <span>changed {summary.changed}</span>
        <span>failed {summary.failures}</span>
        <span>skipped {summary.skipped}</span>
        <Badge variant={OUTCOME_VARIANT[summary.outcome]}>{summary.outcome}</Badge>
      </div>
    </div>
  );
}

export function AutomationPanel({
  hosts,
  selectedHosts,
  onToggleHost,
  checkMode,
  onCheckModeChange,
  onRun,
  isRunning,
  status,
  lines,
  summaries,
  error,
}: Readonly<AutomationPanelProps>) {
  return (
    <div className="flex flex-col gap-4 px-4 pb-4">
      <section className="rounded-lg border border-border bg-card p-4">
        <h5 className="text-sm font-medium mb-3">Hosts</h5>
        {hosts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No managed hosts registered.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {hosts.map((host) => (
              <div key={host} className="flex items-center gap-2">
                <Checkbox
                  id={`host-${host}`}
                  checked={selectedHosts.includes(host)}
                  onCheckedChange={() => onToggleHost(host)}
                />
                <Label htmlFor={`host-${host}`} className="font-mono text-sm">
                  {host}
                </Label>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 mt-4">
          <Checkbox
            id="ansible-check-mode"
            checked={checkMode}
            onCheckedChange={(checked) => onCheckModeChange(checked === true)}
          />
          <Label htmlFor="ansible-check-mode" className="text-sm">
            Preview only (--check --diff)
          </Label>
        </div>

        <Button
          className="mt-4"
          onClick={onRun}
          disabled={isRunning || selectedHosts.length === 0}
        >
          {isRunning ? 'Running...' : 'Run host baseline'}
        </Button>

        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </section>

      {status && (
        <section className="rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <h5 className="text-sm font-medium">Run output</h5>
            <Badge variant={status === 'failed' ? 'destructive' : 'secondary'}>{status}</Badge>
          </div>
          <pre className="max-h-80 overflow-auto px-3 py-2 text-xs font-mono text-muted-foreground">
            {lines.map((line) => (
              <div key={line.key}>
                {line.label}
                {line.detail ? ` [${line.detail}]` : ''}
              </div>
            ))}
          </pre>
        </section>
      )}

      {summaries.length > 0 && (
        <section className="rounded-lg border border-border bg-card">
          <h5 className="text-sm font-medium px-3 py-2 border-b border-border">Per-host result</h5>
          {summaries.map((summary) => (
            <SummaryRow key={summary.host} summary={summary} />
          ))}
        </section>
      )}
    </div>
  );
}
