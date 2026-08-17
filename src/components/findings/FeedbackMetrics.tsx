import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils/cn';
import { getFeedbackMetrics } from '@/data/feedback/functions';

const FEEDBACK_METRICS_QUERY_KEY = ['feedback-metrics'] as const;

/**
 * Local mirror of `FeedbackMetrics` (`src/lib/feedback/metrics-service.ts`, spec §D):
 * that module is built in parallel by another engineer and isn't on disk yet, so this
 * component owns its own shape rather than importing one that doesn't exist.
 */
export interface FeedbackMetricsData {
  findings: { total: number; previousTotal: number };
  coverage: { labeled: number; total: number; coverage: number };
  precision: {
    value: number | null;
    n: number;
    wilson95: { low: number; high: number } | null;
    withheldReason: 'insufficient_labels' | 'insufficient_coverage' | null;
    decisive: { actionable: number; noise: number; wrong: number };
  };
  reportedMisses: {
    total: number;
    byAttributionVerdict: Partial<Record<string, number>>;
  };
  tierZeroLatency: {
    medianMs: number | null;
    p90Ms: number | null;
    n: number;
    latenciesMs: number[];
    neverDispatched: number;
  };
  spend: {
    totalRuns: number;
    byBucket: Partial<Record<string, number>>;
    estimatedCostUsd: number | null;
  };
  rulesTransitions: { total: number };
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

interface TileProps {
  label: string;
  value: string;
  detail?: string;
}

function Tile({ label, value, detail }: Readonly<TileProps>) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium">
        {value}
        {detail && <span className="ml-1 font-normal text-muted-foreground">({detail})</span>}
      </span>
    </div>
  );
}

function PrecisionTile({ precision }: { precision: FeedbackMetricsData['precision'] }) {
  if (precision.value === null) {
    const reason =
      precision.withheldReason === 'insufficient_coverage'
        ? "not enough of this week's findings are labelled yet"
        : `not enough labels yet (${precision.n} of 20)`;
    return (
      <Tile
        label="Precision"
        value="n too small"
        detail={`${reason} - ${precision.decisive.actionable} actionable, ${precision.decisive.noise} noise, ${precision.decisive.wrong} wrong`}
      />
    );
  }
  const wilson = precision.wilson95;
  return (
    <Tile
      label="Precision"
      value={`${formatPercent(precision.value)} (n=${precision.n})`}
      detail={wilson ? `95% CI ${formatPercent(wilson.low)}-${formatPercent(wilson.high)}` : undefined}
    />
  );
}

function MissesTile({ misses }: { misses: FeedbackMetricsData['reportedMisses'] }) {
  const breakdown = Object.entries(misses.byAttributionVerdict)
    .filter((entry): entry is [string, number] => (entry[1] ?? 0) > 0)
    .map(([verdict, count]) => `${count} ${verdict.replace(/_/g, ' ')}`)
    .join(', ');
  return <Tile label="Reported misses" value={String(misses.total)} detail={breakdown || undefined} />;
}

function LatencyTile({ latency }: { latency: FeedbackMetricsData['tierZeroLatency'] }) {
  if (latency.medianMs === null) {
    const listed = latency.latenciesMs.map((ms) => formatSeconds(ms)).join(', ');
    return (
      <Tile
        label="Tier-0 notification"
        value={latency.n === 0 ? 'no data' : listed}
        detail={`n=${latency.n}, too few to summarize`}
      />
    );
  }
  const p90 = latency.p90Ms !== null ? formatSeconds(latency.p90Ms) : 'n/a';
  return (
    <Tile
      label="Tier-0 notification"
      value={`median ${formatSeconds(latency.medianMs)} · p90 ${p90} (n=${latency.n})`}
      detail={latency.neverDispatched > 0 ? `${latency.neverDispatched} never dispatched` : undefined}
    />
  );
}

function SpendTile({ spend }: { spend: FeedbackMetricsData['spend'] }) {
  const breakdown = Object.entries(spend.byBucket)
    .map(([bucket, count]) => `${bucket}: ${count ?? 0}`)
    .join(', ');
  const cost = spend.estimatedCostUsd !== null ? ` (~$${spend.estimatedCostUsd.toFixed(2)} est.)` : '';
  return <Tile label="Spend" value={`${spend.totalRuns} runs${cost}`} detail={breakdown || undefined} />;
}

export function FeedbackMetrics() {
  const [expanded, setExpanded] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: FEEDBACK_METRICS_QUERY_KEY,
    queryFn: async () => (await getFeedbackMetrics({ data: {} })) as unknown as FeedbackMetricsData,
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        <span>Loading feedback metrics…</span>
      </div>
    );
  }

  if (isError || !data) {
    return <div className="border-b border-border px-4 py-3 text-sm text-destructive">Feedback metrics unavailable</div>;
  }

  const delta = data.findings.total - data.findings.previousTotal;
  const deltaLabel = delta === 0 ? 'no change' : `${delta > 0 ? '+' : ''}${delta} vs last week`;

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} className="border-b border-border">
      <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-2 text-left hover:bg-accent">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
          <Tile label="Findings this week" value={String(data.findings.total)} detail={deltaLabel} />
          <Tile label="Labelled" value={`${data.coverage.labeled}/${data.coverage.total} (${formatPercent(data.coverage.coverage)})`} />
          <PrecisionTile precision={data.precision} />
          <MissesTile misses={data.reportedMisses} />
          <LatencyTile latency={data.tierZeroLatency} />
          <SpendTile spend={data.spend} />
        </div>
        <ChevronRight size={14} className={cn('shrink-0 transition-transform duration-200', expanded && 'rotate-90')} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-1 px-4 pb-3 text-xs text-muted-foreground">
          <p>
            Findings this week counts finding rows, not occurrences: a fault that recurs 400 times inside one open
            finding is one finding.
          </p>
          <p>Precision counts decisive operator verdicts only (actionable, noise, wrong); duplicates and unlabelled findings are excluded.</p>
          <p>Reported recall is an upper bound: it only counts misses a human noticed and filed.</p>
          {data.rulesTransitions.total > 0 && <p>{data.rulesTransitions.total} rule transition(s) recorded.</p>}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export default FeedbackMetrics;
