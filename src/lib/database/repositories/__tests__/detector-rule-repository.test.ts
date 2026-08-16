import { describe, it, expect, beforeEach } from 'bun:test';
import { DetectorRuleRepository, type UpsertDetectorRuleInput } from '../detector-rule-repository';
import { createMockPool } from '@/lib/test/mock-pool';

function baseInput(overrides: Partial<UpsertDetectorRuleInput> = {}): UpsertDetectorRuleInput {
  return {
    id: 'seed:level-warn',
    version: 1,
    name: 'WARN level token',
    kind: 'match',
    matcher: { type: 'regex', pattern: '\\bWARN\\b', flags: '', target: 'raw', stream: 'any' },
    lane: 'batch',
    state: 'active',
    enabled: true,
    scope: { kind: 'fleet' },
    appliesToTiers: null,
    priority: 0,
    hardSignal: false,
    operatorApproved: true,
    canaryUntil: null,
    cooldownMs: null,
    origin: 'seed',
    proposedByRunId: null,
    proposedFromFindingId: null,
    rationale: 'routine warning token',
    ...overrides,
  };
}

describe('DetectorRuleRepository', () => {
  let mockPool: ReturnType<typeof createMockPool>;
  let repo: DetectorRuleRepository;

  beforeEach(() => {
    mockPool = createMockPool();
    repo = new DetectorRuleRepository(mockPool.pool);
  });

  describe('upsertRule', () => {
    it('upserts with serialized matcher/scope and all fields as positional params', async () => {
      const input = baseInput();
      await repo.upsertRule(input);

      expect(mockPool.queries).toHaveLength(1);
      const { sql, params } = mockPool.queries[0];
      expect(sql).toContain('detector_rules');
      expect(sql).toContain('ON CONFLICT (id) DO UPDATE');
      expect(params).toEqual([
        'seed:level-warn',
        1,
        'WARN level token',
        'match',
        JSON.stringify(input.matcher),
        'batch',
        'active',
        true,
        JSON.stringify(input.scope),
        null,
        0,
        false,
        true,
        null,
        null,
        'seed',
        null,
        null,
        'routine warning token',
      ]);
    });

    it('propagates database errors instead of swallowing them', async () => {
      mockPool.setError(new Error('connection terminated'));
      await expect(repo.upsertRule(baseInput())).rejects.toThrow('connection terminated');
    });
  });

  describe('getRule', () => {
    it('maps a found row, parsing JSONB matcher/scope and applies_to_tiers as-is', async () => {
      const createdAt = new Date('2026-08-01T00:00:00Z');
      const updatedAt = new Date('2026-08-15T00:00:00Z');
      mockPool.setDefault([
        {
          id: 'seed:level-error-t0',
          version: 1,
          name: 'ERROR level token (tier 0)',
          kind: 'match',
          matcher: { type: 'regex', pattern: '\\bERROR\\b', flags: '', target: 'raw', stream: 'any' },
          lane: 'triage',
          state: 'active',
          enabled: true,
          scope: { kind: 'fleet' },
          applies_to_tiers: [0],
          priority: 0,
          hard_signal: false,
          operator_approved: true,
          canary_until: null,
          cooldown_ms: null,
          origin: 'seed',
          proposed_by_run_id: null,
          proposed_from_finding_id: null,
          rationale: 'critical tier only',
          created_at: createdAt,
          updated_at: updatedAt,
          promoted_at: updatedAt,
        },
      ]);

      const rule = await repo.getRule('seed:level-error-t0');

      expect(rule).toEqual({
        id: 'seed:level-error-t0',
        version: 1,
        name: 'ERROR level token (tier 0)',
        kind: 'match',
        matcher: { type: 'regex', pattern: '\\bERROR\\b', flags: '', target: 'raw', stream: 'any' },
        lane: 'triage',
        state: 'active',
        enabled: true,
        scope: { kind: 'fleet' },
        appliesToTiers: [0],
        priority: 0,
        hardSignal: false,
        operatorApproved: true,
        canaryUntil: null,
        cooldownMs: null,
        provenance: {
          origin: 'seed',
          proposedByRunId: null,
          proposedFromFindingId: null,
          rationale: 'critical tier only',
          createdAt,
          updatedAt,
          promotedAt: updatedAt,
        },
      });
    });

    it('parses matcher/scope when the driver returns them as JSON strings', async () => {
      const at = new Date('2026-08-01T00:00:00Z');
      mockPool.setDefault([
        {
          id: 'seed:silence',
          version: 1,
          name: 'Unexpected silence',
          kind: 'silence',
          matcher: JSON.stringify({ type: 'silence', windowMs: 300000 }),
          lane: 'triage',
          state: 'active',
          enabled: true,
          scope: JSON.stringify({ kind: 'fleet' }),
          applies_to_tiers: null,
          priority: 0,
          hard_signal: false,
          operator_approved: true,
          canary_until: null,
          cooldown_ms: null,
          origin: 'seed',
          proposed_by_run_id: null,
          proposed_from_finding_id: null,
          rationale: 'quiet container',
          created_at: at,
          updated_at: at,
          promoted_at: at,
        },
      ]);

      const rule = await repo.getRule('seed:silence');
      expect(rule?.matcher).toEqual({ type: 'silence', windowMs: 300000 });
      expect(rule?.scope).toEqual({ kind: 'fleet' });
      expect(rule?.appliesToTiers).toBeNull();
    });

    it('returns null when no row matches', async () => {
      mockPool.setDefault([]);
      const rule = await repo.getRule('nope');
      expect(rule).toBeNull();
    });

    it('propagates database errors instead of swallowing them', async () => {
      mockPool.setError(new Error('connection terminated'));
      await expect(repo.getRule('seed:silence')).rejects.toThrow('connection terminated');
    });
  });

  describe('listEvaluableRules', () => {
    it('queries enabled rules in active or shadow state', async () => {
      mockPool.setDefault([]);
      await repo.listEvaluableRules();

      expect(mockPool.queries[0].sql).toContain('enabled AND state IN');
      expect(mockPool.queries[0].params).toEqual([]);
    });

    it('propagates database errors instead of swallowing them', async () => {
      mockPool.setError(new Error('connection terminated'));
      await expect(repo.listEvaluableRules()).rejects.toThrow('connection terminated');
    });
  });

  describe('listRulesByState', () => {
    it('filters by the given state', async () => {
      mockPool.setDefault([]);
      await repo.listRulesByState('shadow');

      expect(mockPool.queries[0].sql).toContain('WHERE state = $1');
      expect(mockPool.queries[0].params).toEqual(['shadow']);
    });

    it('propagates database errors instead of swallowing them', async () => {
      mockPool.setError(new Error('connection terminated'));
      await expect(repo.listRulesByState('proposed')).rejects.toThrow('connection terminated');
    });
  });

  describe('setRuleState', () => {
    it('returns true when a row was updated', async () => {
      mockPool.setDefault([{}]);
      const at = new Date('2026-08-15T00:00:00Z');
      const result = await repo.setRuleState('seed:silence', 'active', at);

      expect(result).toBe(true);
      expect(mockPool.queries[0].sql).toContain('UPDATE detector_rules');
      expect(mockPool.queries[0].params).toEqual(['seed:silence', 'active', at]);
    });

    it('returns false when no rule matched the id', async () => {
      mockPool.setDefault([]);
      const result = await repo.setRuleState('nope', 'retired', new Date());
      expect(result).toBe(false);
    });
  });

  describe('setRuleEnabled', () => {
    it('returns true when a row was updated', async () => {
      mockPool.setDefault([{}]);
      const result = await repo.setRuleEnabled('seed:silence', false);

      expect(result).toBe(true);
      expect(mockPool.queries[0].sql).toContain('UPDATE detector_rules');
      expect(mockPool.queries[0].params).toEqual(['seed:silence', false]);
    });

    it('returns false when no rule matched the id', async () => {
      mockPool.setDefault([]);
      const result = await repo.setRuleEnabled('nope', true);
      expect(result).toBe(false);
    });

    it('propagates database errors instead of swallowing them', async () => {
      mockPool.setError(new Error('connection terminated'));
      await expect(repo.setRuleEnabled('seed:silence', true)).rejects.toThrow('connection terminated');
    });
  });
});
