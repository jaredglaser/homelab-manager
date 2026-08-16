import type { LogLane, Tier } from '@/lib/logs/types';
import { LANE_SEVERITY } from '@/lib/logs/types';

export const DEFAULT_TIER: Tier = 1;

const VALID_TIER_STRINGS: Readonly<Record<string, Tier>> = { '0': 0, '1': 1, '2': 2 };

export function parseTier(raw: string | null | undefined): Tier {
  if (raw === null || raw === undefined) return DEFAULT_TIER;
  return VALID_TIER_STRINGS[raw] ?? DEFAULT_TIER;
}

export function resolveTier(metadata: ReadonlyMap<string, string> | undefined): Tier {
  return parseTier(metadata?.get('criticality'));
}

export interface TierPolicy {
  readonly tier: Tier;
  readonly debounceMs: number;
  readonly cooldownMs: number;
  readonly instantPage: boolean;
  readonly triageRoute: string;
  readonly budgetShare: number;
  readonly budgetReserved: boolean;
  readonly prewarmDigest: boolean;
}

export const PAGE_ROUTE = 'homelab-page-t0';

export const TRIAGE_ROUTES: Readonly<Record<Tier, string>> = {
  0: 'homelab-log-triage-t0',
  1: 'homelab-log-triage-t1',
  2: 'homelab-log-triage-t2',
};

export const TIER_POLICIES: Readonly<Record<Tier, TierPolicy>> = {
  0: {
    tier: 0,
    debounceMs: 2_000,
    cooldownMs: 60_000,
    instantPage: true,
    triageRoute: TRIAGE_ROUTES[0],
    budgetShare: 0.4,
    budgetReserved: true,
    prewarmDigest: true,
  },
  1: {
    tier: 1,
    debounceMs: 30_000,
    cooldownMs: 600_000,
    instantPage: false,
    triageRoute: TRIAGE_ROUTES[1],
    budgetShare: 0.6,
    budgetReserved: false,
    prewarmDigest: false,
  },
  2: {
    tier: 2,
    debounceMs: 300_000,
    cooldownMs: 3_600_000,
    instantPage: false,
    triageRoute: TRIAGE_ROUTES[2],
    budgetShare: 0.25,
    budgetReserved: false,
    prewarmDigest: false,
  },
};

export function policyFor(tier: Tier): TierPolicy {
  return TIER_POLICIES[tier];
}

export function routeFor(tier: Tier, lane: LogLane): string {
  return lane === 'page' ? PAGE_ROUTE : TRIAGE_ROUTES[tier];
}

export interface HermesCeilings {
  readonly maxInFlight: number;
  readonly maxDailyRuns: number;
  readonly maxDailyPages: number;
}

export const DEFAULT_CEILINGS: HermesCeilings = {
  maxInFlight: 8,
  maxDailyRuns: 300,
  maxDailyPages: 200,
};

export interface DerivedCapacity {
  readonly runningContainers: number;
  readonly maxInFlight: number;
  readonly t0Reserved: number;
  readonly sharedPool: number;
  readonly t2Ceiling: number;
  readonly dailyRuns: number;
  readonly dailyPages: number;
  readonly dailyByBucket: Readonly<Record<'t0' | 't1' | 't2', number>>;
}

const CONTAINERS_PER_INFLIGHT_SLOT = 25;
const RUNS_PER_CONTAINER_PER_DAY = 2;
const MIN_DAILY_RUNS = 20;
const MIN_DAILY_PAGES = 20;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function deriveCapacity(runningContainers: number, ceilings: HermesCeilings): DerivedCapacity {
  const running = Math.max(0, runningContainers);

  const maxInFlight = clamp(Math.ceil(running / CONTAINERS_PER_INFLIGHT_SLOT), 1, ceilings.maxInFlight);
  const dailyRuns = clamp(running * RUNS_PER_CONTAINER_PER_DAY, MIN_DAILY_RUNS, ceilings.maxDailyRuns);
  const dailyPages = clamp(running, MIN_DAILY_PAGES, ceilings.maxDailyPages);

  const t0Reserved = Math.max(1, Math.ceil(maxInFlight * 0.5));
  const sharedPool = Math.max(1, maxInFlight - t0Reserved);
  const t2Ceiling = Math.max(1, Math.floor(sharedPool / 2));

  const t0 = Math.max(1, Math.ceil(dailyRuns * TIER_POLICIES[0].budgetShare));
  const t2 = Math.max(1, Math.floor(dailyRuns * TIER_POLICIES[2].budgetShare));
  const t1 = Math.max(1, dailyRuns - t0 - t2);

  return {
    runningContainers: running,
    maxInFlight,
    t0Reserved,
    sharedPool,
    t2Ceiling,
    dailyRuns,
    dailyPages,
    dailyByBucket: { t0, t1, t2 },
  };
}

export function mostSevereLane(a: LogLane, b: LogLane): LogLane {
  return LANE_SEVERITY[b] > LANE_SEVERITY[a] ? b : a;
}

export function mostCriticalTier(a: Tier, b: Tier): Tier {
  return b < a ? b : a;
}
