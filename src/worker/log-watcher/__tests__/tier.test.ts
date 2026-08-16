import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_CEILINGS,
  DEFAULT_TIER,
  PAGE_ROUTE,
  TIER_POLICIES,
  TRIAGE_ROUTES,
  deriveCapacity,
  mostCriticalTier,
  mostSevereLane,
  parseTier,
  policyFor,
  resolveTier,
  routeFor,
} from '@/worker/log-watcher/tier';

describe('parseTier', () => {
  it('defaults to tier 1 when the raw value is null', () => {
    expect(parseTier(null)).toBe(DEFAULT_TIER);
  });

  it('defaults to tier 1 when the raw value is undefined', () => {
    expect(parseTier(undefined)).toBe(DEFAULT_TIER);
  });

  it('parses an explicit tier 0', () => {
    expect(parseTier('0')).toBe(0);
  });

  it('parses an explicit tier 1', () => {
    expect(parseTier('1')).toBe(1);
  });

  it('parses an explicit tier 2', () => {
    expect(parseTier('2')).toBe(2);
  });

  it('defaults to tier 1 for an invalid stored value', () => {
    expect(parseTier('x')).toBe(DEFAULT_TIER);
  });

  it('defaults to tier 1 for an out-of-range numeric string', () => {
    expect(parseTier('3')).toBe(DEFAULT_TIER);
    expect(parseTier('-1')).toBe(DEFAULT_TIER);
  });

  it('defaults to tier 1 for an empty string', () => {
    expect(parseTier('')).toBe(DEFAULT_TIER);
  });
});

describe('resolveTier', () => {
  it('defaults to tier 1 when metadata is undefined', () => {
    expect(resolveTier(undefined)).toBe(DEFAULT_TIER);
  });

  it('defaults to tier 1 when metadata has no criticality key', () => {
    const metadata = new Map<string, string>([['icon', 'jellyfin']]);
    expect(resolveTier(metadata)).toBe(DEFAULT_TIER);
  });

  it('resolves an explicit stored tier', () => {
    const metadata = new Map<string, string>([['criticality', '0']]);
    expect(resolveTier(metadata)).toBe(0);
  });

  it('defaults to tier 1 for a garbage stored value', () => {
    const metadata = new Map<string, string>([['criticality', 'critical']]);
    expect(resolveTier(metadata)).toBe(DEFAULT_TIER);
  });

  it('reflects a tier change at runtime without any caching in the resolver itself', () => {
    const entityId = 'server1/abc123';
    const before = new Map<string, Map<string, string>>([[entityId, new Map([['criticality', '2']])]]);
    expect(resolveTier(before.get(entityId))).toBe(2);

    const after = new Map<string, Map<string, string>>([[entityId, new Map([['criticality', '0']])]]);
    expect(resolveTier(after.get(entityId))).toBe(0);
  });
});

describe('policyFor / routeFor', () => {
  it('returns the tier 0 policy with an instant page and a reserved budget', () => {
    const policy = policyFor(0);
    expect(policy.tier).toBe(0);
    expect(policy.instantPage).toBe(true);
    expect(policy.budgetReserved).toBe(true);
    expect(policy.prewarmDigest).toBe(true);
    expect(policy.debounceMs).toBe(2_000);
    expect(policy.cooldownMs).toBe(60_000);
  });

  it('returns the tier 1 policy with no instant page and a shared budget', () => {
    const policy = policyFor(1);
    expect(policy.instantPage).toBe(false);
    expect(policy.budgetReserved).toBe(false);
    expect(policy.prewarmDigest).toBe(false);
    expect(policy.debounceMs).toBe(30_000);
    expect(policy.cooldownMs).toBe(600_000);
  });

  it('returns the tier 2 policy with the longest debounce and cooldown', () => {
    const policy = policyFor(2);
    expect(policy.debounceMs).toBe(300_000);
    expect(policy.cooldownMs).toBe(3_600_000);
    expect(policy.budgetReserved).toBe(false);
  });

  it('every policy in TIER_POLICIES matches its own tier key', () => {
    for (const tier of [0, 1, 2] as const) {
      expect(TIER_POLICIES[tier].tier).toBe(tier);
      expect(TIER_POLICIES[tier].triageRoute).toBe(TRIAGE_ROUTES[tier]);
    }
  });

  it('routes a page-lane signal to the shared page route regardless of tier', () => {
    expect(routeFor(0, 'page')).toBe(PAGE_ROUTE);
    expect(routeFor(1, 'page')).toBe(PAGE_ROUTE);
    expect(routeFor(2, 'page')).toBe(PAGE_ROUTE);
  });

  it('routes a triage-lane signal to the per-tier triage route', () => {
    expect(routeFor(0, 'triage')).toBe('homelab-log-triage-t0');
    expect(routeFor(1, 'triage')).toBe('homelab-log-triage-t1');
    expect(routeFor(2, 'triage')).toBe('homelab-log-triage-t2');
  });
});

describe('deriveCapacity', () => {
  it('clamps to a minimum of 1 in-flight slot and the daily minimums with zero running containers', () => {
    const capacity = deriveCapacity(0, DEFAULT_CEILINGS);
    expect(capacity.runningContainers).toBe(0);
    expect(capacity.maxInFlight).toBe(1);
    expect(capacity.dailyRuns).toBe(20);
    expect(capacity.dailyPages).toBe(20);
    expect(capacity.t0Reserved).toBeGreaterThanOrEqual(1);
    expect(capacity.sharedPool).toBeGreaterThanOrEqual(1);
    expect(capacity.t2Ceiling).toBeGreaterThanOrEqual(1);
  });

  it('scales up from a single running container', () => {
    const capacity = deriveCapacity(1, DEFAULT_CEILINGS);
    expect(capacity.maxInFlight).toBe(1);
    expect(capacity.dailyRuns).toBe(20);
    expect(capacity.dailyPages).toBe(20);
  });

  it('scales the in-flight ceiling at 25 running containers', () => {
    const capacity = deriveCapacity(25, DEFAULT_CEILINGS);
    expect(capacity.maxInFlight).toBe(1);
    expect(capacity.dailyRuns).toBe(50);
    expect(capacity.dailyPages).toBe(25);
  });

  it('scales further at 100 running containers, respecting the maxInFlight ceiling', () => {
    const capacity = deriveCapacity(100, DEFAULT_CEILINGS);
    expect(capacity.maxInFlight).toBe(4);
    expect(capacity.dailyRuns).toBe(200);
    expect(capacity.dailyPages).toBe(100);
  });

  it('caps at the operator ceiling at 400 running containers', () => {
    const capacity = deriveCapacity(400, DEFAULT_CEILINGS);
    expect(capacity.maxInFlight).toBe(DEFAULT_CEILINGS.maxInFlight);
    expect(capacity.dailyRuns).toBe(DEFAULT_CEILINGS.maxDailyRuns);
    expect(capacity.dailyPages).toBe(DEFAULT_CEILINGS.maxDailyPages);
  });

  it('never exceeds the operator ceiling at extreme fleet sizes', () => {
    const capacity = deriveCapacity(10_000, DEFAULT_CEILINGS);
    expect(capacity.maxInFlight).toBe(DEFAULT_CEILINGS.maxInFlight);
    expect(capacity.dailyRuns).toBe(DEFAULT_CEILINGS.maxDailyRuns);
    expect(capacity.dailyPages).toBe(DEFAULT_CEILINGS.maxDailyPages);
  });

  it('never lets the tier-0 reserve fall below 1 slot, even at the smallest ceiling', () => {
    for (const running of [0, 1, 25, 100, 400, 10_000]) {
      const capacity = deriveCapacity(running, { maxInFlight: 1, maxDailyRuns: 20, maxDailyPages: 20 });
      expect(capacity.t0Reserved).toBeGreaterThanOrEqual(1);
      expect(capacity.sharedPool).toBeGreaterThanOrEqual(1);
    }
  });

  it('never lets the tier-2 ceiling exceed the shared pool', () => {
    for (const running of [0, 1, 25, 100, 400, 10_000]) {
      const capacity = deriveCapacity(running, DEFAULT_CEILINGS);
      expect(capacity.t2Ceiling).toBeLessThanOrEqual(capacity.sharedPool);
    }
  });

  it('splits the daily run budget across the three tier buckets summing near the total', () => {
    const capacity = deriveCapacity(100, DEFAULT_CEILINGS);
    const { t0, t1, t2 } = capacity.dailyByBucket;
    expect(t0).toBeGreaterThanOrEqual(1);
    expect(t1).toBeGreaterThanOrEqual(1);
    expect(t2).toBeGreaterThanOrEqual(1);
    expect(t0 + t1 + t2).toBeLessThanOrEqual(capacity.dailyRuns + 2);
    expect(t0 + t1 + t2).toBeGreaterThanOrEqual(capacity.dailyRuns - 2);
  });

  it('gives tier 0 the largest share of the daily budget among the three buckets', () => {
    const capacity = deriveCapacity(400, DEFAULT_CEILINGS);
    const { t0, t1, t2 } = capacity.dailyByBucket;
    expect(t0).toBeGreaterThan(t2);
    expect(t1).toBeGreaterThan(0);
  });

  it('treats a negative running count as zero rather than going negative', () => {
    const capacity = deriveCapacity(-5, DEFAULT_CEILINGS);
    expect(capacity.runningContainers).toBe(0);
    expect(capacity.dailyRuns).toBe(20);
  });
});

describe('mostSevereLane', () => {
  it('picks page over triage', () => {
    expect(mostSevereLane('page', 'triage')).toBe('page');
    expect(mostSevereLane('triage', 'page')).toBe('page');
  });

  it('picks triage over batch', () => {
    expect(mostSevereLane('triage', 'batch')).toBe('triage');
  });

  it('picks batch over count', () => {
    expect(mostSevereLane('batch', 'count')).toBe('batch');
  });

  it('returns the shared lane when both are equal', () => {
    expect(mostSevereLane('count', 'count')).toBe('count');
  });
});

describe('mostCriticalTier', () => {
  it('picks the numerically lower tier as more critical', () => {
    expect(mostCriticalTier(0, 2)).toBe(0);
    expect(mostCriticalTier(2, 0)).toBe(0);
  });

  it('picks tier 1 over tier 2', () => {
    expect(mostCriticalTier(1, 2)).toBe(1);
  });

  it('returns the shared tier when both are equal', () => {
    expect(mostCriticalTier(1, 1)).toBe(1);
  });
});
