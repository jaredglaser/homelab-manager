/**
 * Mock feedback server functions for demo and e2e mode. The real ones read the
 * finding_labels and reported_incidents tables; here the fleet has produced no
 * findings, so every read returns an empty set and every metric is withheld for
 * insufficient labels, which is the same state a freshly installed deployment
 * shows before anyone has clicked a verdict.
 */
import type { FeedbackMetrics } from '@/lib/feedback/metrics-service';

const EMPTY_METRICS: FeedbackMetrics = {
  findings: { total: 0, previousTotal: 0 },
  coverage: { labeled: 0, total: 0, coverage: 0 },
  precision: {
    value: null,
    n: 0,
    wilson95: null,
    withheldReason: 'insufficient_labels',
    decisive: { actionable: 0, noise: 0, wrong: 0 },
  },
  reportedMisses: { total: 0, byAttributionVerdict: {} },
  tierZeroLatency: { medianMs: null, p90Ms: null, n: 0, latenciesMs: [], neverDispatched: 0 },
  spend: { totalRuns: 0, byBucket: {}, estimatedCostUsd: null },
  rulesTransitions: { total: 0 },
};

export function getFeedbackMetrics(): FeedbackMetrics {
  return EMPTY_METRICS;
}

export function listFindingVerdicts() {
  return { verdicts: [], weakSignals: [] };
}

export function listReportedMisses() {
  return [];
}

function unsupported(action: string): never {
  throw new Error(`${action} is not available in demo mode`);
}

export function labelFinding(): never {
  unsupported('Labelling a finding');
}

export function reportMiss(): never {
  unsupported('Reporting a miss');
}

export function setMissStatus(): never {
  unsupported('Changing a reported miss');
}

export function reattributeMiss(): never {
  unsupported('Re-attributing a reported miss');
}
