import type { Pool } from 'pg';
import type { MetricPeriod } from '@/lib/feedback/metrics';
import { ReportedMissRepository, IncidentRepository } from '@/lib/database/repositories/reported-incident-repository';
import type { AttributionVerdict } from '@/lib/database/repositories/reported-incident-repository';

const MIN_DECISIVE_LABELS = 20;
const MIN_COVERAGE = 0.5;

export interface FeedbackMetrics {
  readonly findings: { readonly total: number; readonly previousTotal: number };
  readonly coverage: { readonly labeled: number; readonly total: number; readonly coverage: number };
  readonly precision: {
    readonly value: number | null;
    readonly n: number;
    readonly wilson95: { readonly low: number; readonly high: number } | null;
    readonly withheldReason: 'insufficient_labels' | 'insufficient_coverage' | null;
    readonly decisive: { readonly actionable: number; readonly noise: number; readonly wrong: number };
  };
  readonly reportedMisses: {
    readonly total: number;
    readonly byAttributionVerdict: Partial<Record<AttributionVerdict, number>>;
  };
  readonly tierZeroLatency: {
    readonly medianMs: number | null;
    readonly p90Ms: number | null;
    readonly n: number;
    readonly latenciesMs: number[];
    readonly neverDispatched: number;
  };
  readonly spend: {
    readonly totalRuns: number;
    readonly byBucket: Partial<Record<string, number>>;
    readonly estimatedCostUsd: number | null;
  };
  readonly rulesTransitions: { readonly total: number };
}

// A Wilson score interval, not a normal approximation: it stays inside [0,1] and does not
// collapse to a zero-width interval at n=0 the way a naive sqrt(p(1-p)/n) bound would.
function wilsonInterval(successes: number, n: number): { low: number; high: number } {
  const z = 1.96;
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: (center - margin) / denominator, high: (center + margin) / denominator };
}

function percentile(sorted: readonly number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx]!;
}

function periodDurationMs(period: MetricPeriod): number {
  return period.to.getTime() - period.from.getTime();
}

async function findingsCounts(pool: Pool, period: MetricPeriod): Promise<{ total: number; labeled: number }> {
  const result = await pool.query(
    `SELECT COUNT(*) AS total, COUNT(c.finding_id) AS labeled
     FROM findings f
     LEFT JOIN finding_label_current c ON c.finding_id = f.id
     WHERE f.first_seen_at >= $1 AND f.first_seen_at < $2`,
    [period.from, period.to],
  );
  const row = result.rows[0] as { total: string | number; labeled: string | number };
  return { total: Number(row.total), labeled: Number(row.labeled) };
}

async function previousFindingsTotal(pool: Pool, period: MetricPeriod): Promise<number> {
  const durationMs = periodDurationMs(period);
  const previousFrom = new Date(period.from.getTime() - durationMs);
  const result = await pool.query(`SELECT COUNT(*) AS n FROM findings WHERE first_seen_at >= $1 AND first_seen_at < $2`, [previousFrom, period.from]);
  return Number((result.rows[0] as { n: string | number }).n);
}

async function decisiveOperatorCounts(pool: Pool, period: MetricPeriod): Promise<{ actionable: number; noise: number; wrong: number }> {
  const result = await pool.query(
    `SELECT c.verdict, COUNT(*) AS n
     FROM findings f
     JOIN finding_label_current c ON c.finding_id = f.id AND c.source = 'operator'
     WHERE f.first_seen_at >= $1 AND f.first_seen_at < $2 AND c.verdict IN ('actionable', 'noise', 'wrong')
     GROUP BY c.verdict`,
    [period.from, period.to],
  );
  const counts = { actionable: 0, noise: 0, wrong: 0 };
  for (const row of result.rows as { verdict: 'actionable' | 'noise' | 'wrong'; n: string | number }[]) {
    counts[row.verdict] = Number(row.n);
  }
  return counts;
}

async function rulesTransitionsTotal(pool: Pool, period: MetricPeriod): Promise<number> {
  const result = await pool.query(`SELECT COUNT(*) AS n FROM detector_rule_transitions WHERE at >= $1 AND at < $2`, [period.from, period.to]);
  return Number((result.rows[0] as { n: string | number }).n);
}

export async function getFeedbackMetrics(pool: Pool, period: MetricPeriod): Promise<FeedbackMetrics> {
  const misses = new ReportedMissRepository(pool);
  const incidents = new IncidentRepository(pool);

  const [findingCounts, previousTotal, decisive, missStatusCounts, missVerdictCounts, latencyData, transitionsTotal] = await Promise.all([
    findingsCounts(pool, period),
    previousFindingsTotal(pool, period),
    decisiveOperatorCounts(pool, period),
    misses.countByStatus(period.from, period.to),
    misses.countByAttributionVerdict(period.from, period.to),
    incidents.tierZeroLatencies(period.from, period.to),
    rulesTransitionsTotal(pool, period),
  ]);

  const decisiveN = decisive.actionable + decisive.noise + decisive.wrong;
  const coverage = findingCounts.total > 0 ? findingCounts.labeled / findingCounts.total : 0;

  let precisionValue: number | null = null;
  let wilson95: { low: number; high: number } | null = null;
  let withheldReason: 'insufficient_labels' | 'insufficient_coverage' | null = null;
  if (decisiveN < MIN_DECISIVE_LABELS) {
    withheldReason = 'insufficient_labels';
  } else if (coverage < MIN_COVERAGE) {
    withheldReason = 'insufficient_coverage';
  } else {
    precisionValue = decisive.actionable / decisiveN;
    wilson95 = wilsonInterval(decisive.actionable, decisiveN);
  }

  const sortedLatencies = [...latencyData.latencies].sort((a, b) => a - b);
  const medianMs = sortedLatencies.length > 0 ? percentile(sortedLatencies, 0.5) : null;
  const p90Ms = sortedLatencies.length > 0 ? percentile(sortedLatencies, 0.9) : null;
  const neverDispatched = Object.values(latencyData.neverDispatched).reduce((sum, n) => sum + n, 0);

  const reportedMissesTotal = Object.values(missStatusCounts).reduce((sum, n) => sum + n, 0);

  return {
    findings: { total: findingCounts.total, previousTotal },
    coverage: { labeled: findingCounts.labeled, total: findingCounts.total, coverage },
    precision: { value: precisionValue, n: decisiveN, wilson95, withheldReason, decisive },
    reportedMisses: { total: reportedMissesTotal, byAttributionVerdict: missVerdictCounts },
    tierZeroLatency: { medianMs, p90Ms, n: sortedLatencies.length, latenciesMs: sortedLatencies, neverDispatched },
    // No run-cost or run-count tracking exists anywhere in this codebase (checked: no
    // spend/cost_usd/token_cost column or table). Reporting zero here is honest; inventing a
    // number would not be.
    spend: { totalRuns: 0, byBucket: {}, estimatedCostUsd: null },
    rulesTransitions: { total: transitionsTotal },
  };
}
