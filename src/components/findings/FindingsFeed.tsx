import { useMemo, useState } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils/cn';
import { useFindings } from '@/hooks/useFindings';
import { FindingCard } from '@/components/findings/FindingCard';

type StatusFilter = 'open' | 'all';

export default function FindingsFeed() {
  const { findings, isConnected, error } = useFindings();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');

  const visible = useMemo(
    () => (statusFilter === 'open' ? findings.filter((f) => f.status === 'open') : findings),
    [findings, statusFilter],
  );

  const hasReceivedAnything = findings.length > 0 || isConnected;

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">Findings</h1>
        <div className="flex items-center gap-3">
          <ToggleGroup
            value={[statusFilter]}
            onValueChange={(value: string[]) => {
              const next = value[0];
              if (next === 'open' || next === 'all') setStatusFilter(next);
            }}
          >
            <ToggleGroupItem value="open">Open</ToggleGroupItem>
            <ToggleGroupItem value="all">All</ToggleGroupItem>
          </ToggleGroup>
          <span
            aria-label={isConnected ? 'Connected' : 'Disconnected'}
            title={isConnected ? 'Connected' : 'Disconnected'}
            className={cn('size-2 rounded-full', isConnected ? 'bg-success' : 'bg-muted-foreground')}
          />
        </div>
      </div>

      <div className="feed flex-1 min-h-0 overflow-y-auto themed-scrollbar">
        <div className="mx-auto w-full max-w-4xl px-4 pb-8 flex flex-col gap-2">
          {error && (
            <p className="text-sm text-destructive">Findings stream unavailable</p>
          )}

          {visible.map((finding) => (
            <FindingCard key={finding.id} finding={finding} />
          ))}

          {visible.length === 0 && !hasReceivedAnything && (
            <div className="flex flex-col items-center justify-center gap-2 py-16">
              <Spinner className="size-4" />
              <span className="text-sm opacity-70">Connecting to the findings stream…</span>
            </div>
          )}

          {visible.length === 0 && hasReceivedAnything && findings.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
              <p className="text-base opacity-50">No findings yet.</p>
              <p className="text-sm text-muted-foreground">
                A triage run records one only when it concludes something is wrong. Most runs conclude nothing.
              </p>
            </div>
          )}

          {visible.length === 0 && hasReceivedAnything && findings.length > 0 && (
            <div className="flex items-center justify-center py-16">
              <p className="text-sm text-muted-foreground">No open findings.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
