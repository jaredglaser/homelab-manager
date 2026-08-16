import { describe, expect, test } from 'bun:test';
import {
  ALLOWED_REGEX_FLAGS,
  MAX_LINE_MATCH_CHARS,
  MAX_PATTERN_CHARS,
  MAX_SHADOW_COUNTERFACTUALS,
  MAX_SUPPRESSED_RECORDED,
  SEEDED_RULES,
  assertSafePattern,
  clampLane,
  compareRuleMatches,
  compileRule,
  compileRules,
  defaultLaneForTier,
  evaluateCompiled,
  evaluateRules,
  isSafePattern,
  ruleAppliesTo,
  scopeSpecificity,
  type ContainerStateEvent,
  type DetectorRule,
  type EventEvalContext,
  type LineEvalContext,
  type RuleMatcher,
  type TickEvalContext,
  type WindowMetrics,
} from '@/lib/logs/rules';
import type { NormalizedShape } from '@/lib/logs/shape';
import type { RateVerdict, SilenceVerdict } from '@/lib/logs/baseline';
import { LOG_LANES, type LogLane } from '@/lib/logs/types';

const ENTITY = 'server1/abc123';
const HOST = 'server1';
const T0 = Date.UTC(2026, 0, 5, 0, 0, 0);

function makeShape(shapeId: string, template = 'plain line'): NormalizedShape {
  return {
    template,
    shapeId,
    placeholderCount: 0,
    tokenCount: template.split(' ').length,
    truncated: false,
    viaJson: false,
    numbers: [],
  };
}

function lineCtx(overrides: Partial<LineEvalContext> = {}): LineEvalContext {
  return {
    trigger: 'line',
    at: T0,
    entityId: ENTITY,
    host: HOST,
    serviceKey: null,
    stackProject: null,
    tier: 1,
    coldStart: false,
    sinceImageChangeMs: null,
    recentRuleMatches: new Map(),
    line: 'plain line',
    stream: 'stdout',
    shape: makeShape('shape1'),
    ...overrides,
  };
}

function makeMetrics(overrides: Partial<WindowMetrics> = {}): WindowMetrics {
  return {
    windowMs: 60_000,
    lineCount: 0,
    stderrCount: 0,
    stderrRatio: 0,
    shapeCounts: new Map(),
    lastNonEmptyAgoMs: 0,
    verdicts: { lines: null, stderr: null, stderrRatio: null },
    silence: null,
    ...overrides,
  };
}

function tickCtx(overrides: Partial<TickEvalContext> = {}): TickEvalContext {
  return {
    trigger: 'tick',
    at: T0,
    entityId: ENTITY,
    host: HOST,
    serviceKey: null,
    stackProject: null,
    tier: 1,
    coldStart: false,
    sinceImageChangeMs: null,
    recentRuleMatches: new Map(),
    metrics: makeMetrics(),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<ContainerStateEvent> = {}): ContainerStateEvent {
  return {
    eventType: 'die',
    state: null,
    exitCode: null,
    oomKilled: false,
    healthStatus: null,
    restartsInWindow: 0,
    windowMs: 600_000,
    ...overrides,
  };
}

function eventCtx(overrides: Partial<EventEvalContext> = {}): EventEvalContext {
  return {
    trigger: 'event',
    at: T0,
    entityId: ENTITY,
    host: HOST,
    serviceKey: null,
    stackProject: null,
    tier: 1,
    coldStart: false,
    sinceImageChangeMs: null,
    recentRuleMatches: new Map(),
    event: makeEvent(),
    ...overrides,
  };
}

function makeVerdict(overrides: Partial<RateVerdict> = {}): RateVerdict {
  return {
    metric: 'stderr',
    observed: 10,
    expected: 2,
    ratio: 5,
    z: 5,
    sd: 1,
    windowMs: 60_000,
    seasonalFactor: 1,
    trusted: true,
    verdict: 'anomalous',
    reason: 'ok',
    ...overrides,
  };
}

function makeSilence(overrides: Partial<SilenceVerdict> = {}): SilenceVerdict {
  return {
    silentForMs: 400_000,
    windowMs: 300_000,
    expectedPerTick: 0.5,
    verdict: 'anomalous',
    reason: 'ok',
    ...overrides,
  };
}

let ruleCounter = 0;

function makeRule(
  overrides: Partial<DetectorRule> & { readonly matcher: RuleMatcher; readonly lane: LogLane },
): DetectorRule {
  ruleCounter++;
  return {
    id: `rule-${ruleCounter}`,
    version: 1,
    name: `rule ${ruleCounter}`,
    kind: 'match',
    state: 'active',
    enabled: true,
    scope: { kind: 'fleet' },
    appliesToTiers: null,
    priority: 0,
    hardSignal: false,
    operatorApproved: false,
    canaryUntil: null,
    cooldownMs: null,
    provenance: {
      origin: 'operator',
      proposedByRunId: null,
      proposedFromFindingId: null,
      rationale: 'test rule',
      createdAt: new Date(T0),
      updatedAt: new Date(T0),
      promotedAt: null,
    },
    ...overrides,
  };
}

function literalRule(needle: string, lane: LogLane, overrides: Partial<DetectorRule> = {}): DetectorRule {
  return makeRule({
    matcher: { type: 'literal', needle, caseSensitive: true, target: 'raw', stream: 'any' },
    lane,
    kind: 'match',
    ...overrides,
  });
}

describe('scopeSpecificity', () => {
  test('ranks entity highest and fleet lowest', () => {
    expect(scopeSpecificity({ kind: 'entity', entityId: ENTITY })).toBe(5);
    expect(scopeSpecificity({ kind: 'service', serviceKey: 'svc' })).toBe(4);
    expect(scopeSpecificity({ kind: 'stack', project: 'proj' })).toBe(3);
    expect(scopeSpecificity({ kind: 'host', host: HOST })).toBe(2);
    expect(scopeSpecificity({ kind: 'fleet' })).toBe(1);
  });
});

describe('ruleAppliesTo', () => {
  test('entity scope requires exact entity match', () => {
    const rule = literalRule('x', 'batch', { scope: { kind: 'entity', entityId: ENTITY } });
    expect(ruleAppliesTo(rule, lineCtx())).toBe(true);
    expect(ruleAppliesTo(rule, lineCtx({ entityId: 'other/def' }))).toBe(false);
  });

  test('service scope requires a non-null matching serviceKey', () => {
    const rule = literalRule('x', 'batch', { scope: { kind: 'service', serviceKey: 'web' } });
    expect(ruleAppliesTo(rule, lineCtx({ serviceKey: null }))).toBe(false);
    expect(ruleAppliesTo(rule, lineCtx({ serviceKey: 'other' }))).toBe(false);
    expect(ruleAppliesTo(rule, lineCtx({ serviceKey: 'web' }))).toBe(true);
  });

  test('stack scope requires a non-null matching project', () => {
    const rule = literalRule('x', 'batch', { scope: { kind: 'stack', project: 'proj' } });
    expect(ruleAppliesTo(rule, lineCtx({ stackProject: null }))).toBe(false);
    expect(ruleAppliesTo(rule, lineCtx({ stackProject: 'proj' }))).toBe(true);
  });

  test('host scope requires exact host match', () => {
    const rule = literalRule('x', 'batch', { scope: { kind: 'host', host: HOST } });
    expect(ruleAppliesTo(rule, lineCtx({ host: 'otherhost' }))).toBe(false);
    expect(ruleAppliesTo(rule, lineCtx({ host: HOST }))).toBe(true);
  });

  test('fleet scope always applies regardless of tier-independent context', () => {
    const rule = literalRule('x', 'batch');
    expect(ruleAppliesTo(rule, lineCtx({ entityId: 'anything/anything' }))).toBe(true);
  });

  test('appliesToTiers null applies to every tier', () => {
    const rule = literalRule('x', 'batch', { appliesToTiers: null });
    expect(ruleAppliesTo(rule, lineCtx({ tier: 0 }))).toBe(true);
    expect(ruleAppliesTo(rule, lineCtx({ tier: 2 }))).toBe(true);
  });

  test('appliesToTiers restricts to listed tiers', () => {
    const rule = literalRule('x', 'batch', { appliesToTiers: [0] });
    expect(ruleAppliesTo(rule, lineCtx({ tier: 0 }))).toBe(true);
    expect(ruleAppliesTo(rule, lineCtx({ tier: 1 }))).toBe(false);
  });
});

describe('defaultLaneForTier', () => {
  test('all six (tier, coldStart) combinations', () => {
    expect(defaultLaneForTier(0, false)).toBe('triage');
    expect(defaultLaneForTier(0, true)).toBe('batch');
    expect(defaultLaneForTier(1, false)).toBe('batch');
    expect(defaultLaneForTier(1, true)).toBe('batch');
    expect(defaultLaneForTier(2, false)).toBe('batch');
    expect(defaultLaneForTier(2, true)).toBe('batch');
  });
});

describe('compareRuleMatches', () => {
  test('higher scope specificity sorts first regardless of lane severity', () => {
    const entityMatch = {
      ruleId: 'a',
      ruleVersion: 1,
      kind: 'match' as const,
      lane: 'count' as const,
      scopeSpecificity: 5,
      priority: 0,
      updatedAt: 0,
      hardSignal: false,
      isCanary: false,
      evidence: { matchedText: null, metric: null, observed: null, expected: null, z: null },
    };
    const fleetMatch = { ...entityMatch, ruleId: 'b', lane: 'triage' as const, scopeSpecificity: 1 };
    expect(compareRuleMatches(entityMatch, fleetMatch)).toBeLessThan(0);
    expect(compareRuleMatches(fleetMatch, entityMatch)).toBeGreaterThan(0);
  });

  test('equal specificity breaks tie by priority', () => {
    const higher = {
      ruleId: 'a',
      ruleVersion: 1,
      kind: 'match' as const,
      lane: 'count' as const,
      scopeSpecificity: 1,
      priority: 100,
      updatedAt: 0,
      hardSignal: false,
      isCanary: false,
      evidence: { matchedText: null, metric: null, observed: null, expected: null, z: null },
    };
    const lower = { ...higher, ruleId: 'b', lane: 'triage' as const, priority: 0 };
    expect(compareRuleMatches(higher, lower)).toBeLessThan(0);
  });

  test('equal specificity and priority breaks tie by lane severity', () => {
    const higher = {
      ruleId: 'a',
      ruleVersion: 1,
      kind: 'match' as const,
      lane: 'triage' as const,
      scopeSpecificity: 1,
      priority: 0,
      updatedAt: 0,
      hardSignal: false,
      isCanary: false,
      evidence: { matchedText: null, metric: null, observed: null, expected: null, z: null },
    };
    const lower = { ...higher, ruleId: 'b', lane: 'batch' as const };
    expect(compareRuleMatches(higher, lower)).toBeLessThan(0);
  });

  test('equal specificity, priority and lane breaks tie by updatedAt descending', () => {
    const newer = {
      ruleId: 'a',
      ruleVersion: 1,
      kind: 'match' as const,
      lane: 'batch' as const,
      scopeSpecificity: 1,
      priority: 0,
      updatedAt: 2000,
      hardSignal: false,
      isCanary: false,
      evidence: { matchedText: null, metric: null, observed: null, expected: null, z: null },
    };
    const older = { ...newer, ruleId: 'b', updatedAt: 1000 };
    expect(compareRuleMatches(newer, older)).toBeLessThan(0);
  });

  test('an invalid-date updatedAt (NaN) falls through to ruleId instead of poisoning the sort', () => {
    const a = {
      ruleId: 'a',
      ruleVersion: 1,
      kind: 'match' as const,
      lane: 'batch' as const,
      scopeSpecificity: 1,
      priority: 0,
      updatedAt: Number.NaN,
      hardSignal: false,
      isCanary: false,
      evidence: { matchedText: null, metric: null, observed: null, expected: null, z: null },
    };
    const b = { ...a, ruleId: 'b' };
    expect(compareRuleMatches(a, b)).toBeLessThan(0);
    expect(compareRuleMatches(b, a)).toBeGreaterThan(0);
  });

  test('equal specificity, priority, lane and updatedAt breaks tie by ruleId ascending', () => {
    const a = {
      ruleId: 'a',
      ruleVersion: 1,
      kind: 'match' as const,
      lane: 'batch' as const,
      scopeSpecificity: 1,
      priority: 0,
      updatedAt: 0,
      hardSignal: false,
      isCanary: false,
      evidence: { matchedText: null, metric: null, observed: null, expected: null, z: null },
    };
    const b = { ...a, ruleId: 'b' };
    expect(compareRuleMatches(a, b)).toBeLessThan(0);
    expect(compareRuleMatches(b, a)).toBeGreaterThan(0);
    expect(compareRuleMatches(a, a)).toBe(0);
  });
});

describe('compileRule / compileRules', () => {
  test('throws on an invalid kind/matcher pairing', () => {
    const rule = literalRule('x', 'batch', { kind: 'threshold' });
    expect(() => compileRule(rule)).toThrow();
  });

  test('compiles a regex matcher and strips g/y flags', () => {
    const rule = makeRule({
      matcher: { type: 'regex', pattern: 'foo', flags: 'gimsy', target: 'raw', stream: 'any' },
      lane: 'batch',
      kind: 'match',
    });
    const compiled = compileRule(rule);
    expect(compiled.regex).not.toBeNull();
    expect(compiled.regex?.flags.includes('g')).toBe(false);
    expect(compiled.regex?.flags.includes('y')).toBe(false);
    for (const flag of compiled.regex?.flags ?? '') {
      expect(ALLOWED_REGEX_FLAGS.includes(flag)).toBe(true);
    }
  });

  test('throws when the pattern only fails to compile once the requested flags are applied', () => {
    const rule = makeRule({
      matcher: { type: 'regex', pattern: 'a{', flags: 'u', target: 'raw', stream: 'any' },
      lane: 'batch',
      kind: 'match',
    });
    expect(isSafePattern('a{').ok).toBe(true);
    expect(() => compileRule(rule)).toThrow();
  });

  test('throws when the regex pattern is unsafe', () => {
    const rule = makeRule({
      matcher: { type: 'regex', pattern: '(a+)+', flags: '', target: 'raw', stream: 'any' },
      lane: 'batch',
      kind: 'match',
    });
    expect(() => compileRule(rule)).toThrow();
  });

  test('compiles a shape matcher into a set', () => {
    const rule = makeRule({ matcher: { type: 'shape', shapeIds: ['a', 'b'] }, lane: 'count', kind: 'match' });
    const compiled = compileRule(rule);
    expect(compiled.shapeIds?.has('a')).toBe(true);
    expect(compiled.shapeIds?.has('c')).toBe(false);
    expect(compiled.regex).toBeNull();
  });

  test('compiles a threshold/silence/event/correlate matcher with no regex or shapeIds', () => {
    const rule = makeRule({
      matcher: { type: 'threshold', metric: 'lineCount', comparison: 'absolute', value: 5, windowMs: 60_000 },
      lane: 'batch',
      kind: 'threshold',
    });
    const compiled = compileRule(rule);
    expect(compiled.regex).toBeNull();
    expect(compiled.shapeIds).toBeNull();
  });

  test('compileRules collects invalid rules and keeps compiling the rest', () => {
    const good = literalRule('good', 'batch');
    const bad = literalRule('bad', 'batch', { kind: 'silence' });
    const set = compileRules([good, bad]);
    expect(set.rules.length).toBe(1);
    expect(set.invalid.length).toBe(1);
    expect(set.invalid[0]?.ruleId).toBe(bad.id);
  });

  test('SEEDED_RULES all compile and every id is unique', () => {
    const set = compileRules(SEEDED_RULES);
    expect(set.invalid).toEqual([]);
    expect(set.rules.length).toBe(SEEDED_RULES.length);
    const ids = new Set(SEEDED_RULES.map((r) => r.id));
    expect(ids.size).toBe(SEEDED_RULES.length);
  });

  test('seed:panic matches real Go panic output, not just the artificial no-space form', () => {
    const panicRule = SEEDED_RULES.find((r) => r.id === 'seed:panic');
    if (!panicRule) throw new Error('seed:panic missing from SEEDED_RULES');
    const compiled = compileRule(panicRule);

    const withSpace = evaluateRules([panicRule], lineCtx({ line: 'panic: runtime error: index out of range', tier: 1 }));
    expect(withSpace.decidingRuleId).toBe('seed:panic');

    const goroutine = evaluateRules(
      [panicRule],
      lineCtx({ line: 'goroutine 1 [running]: panic: send on closed channel', tier: 1 }),
    );
    expect(goroutine.decidingRuleId).toBe('seed:panic');

    expect(compiled.regex?.test('PANICKY')).toBe(false);
  });
});

describe('assertSafePattern / isSafePattern', () => {
  test('an escaped pipe is a literal, not an alternation separator', () => {
    expect(isSafePattern('(a\\|a)').ok).toBe(true);
    expect(isSafePattern('(rx\\|tx\\|rx)').ok).toBe(true);
  });

  test('a pipe inside a character class is a literal, not an alternation separator', () => {
    expect(isSafePattern('([a|b]|[a|b])+').ok).toBe(false);
    expect(isSafePattern('(ERROR|[|]|WARN)+').ok).toBe(true);
  });

  test('duplicate quantified alternation branches are rejected even when the branch is an escape', () => {
    expect(isSafePattern('(\\.|\\.)+').reason).toBe('ambiguous-alternation');
    expect(isSafePattern('(\\]|\\])+').reason).toBe('ambiguous-alternation');
    expect(isSafePattern('(\\.|\\,)+').ok).toBe(true);
  });

  test('an escaped bracket inside a character class does not end the class early', () => {
    expect(isSafePattern('([\\]]|[\\]])+').reason).toBe('ambiguous-alternation');
  });

  test('rejects a nested quantifier', () => {
    expect(isSafePattern('(a+)+').ok).toBe(false);
    expect(() => assertSafePattern('(a+)+')).toThrow();
  });

  test('rejects a backreference', () => {
    expect(isSafePattern('(a)\\1').ok).toBe(false);
    expect(() => assertSafePattern('(a)\\1')).toThrow();
  });

  test('rejects a pattern longer than MAX_PATTERN_CHARS', () => {
    const pattern = 'a'.repeat(MAX_PATTERN_CHARS + 100);
    expect(isSafePattern(pattern).ok).toBe(false);
    expect(() => assertSafePattern(pattern)).toThrow();
  });

  test('rejects a large bounded quantifier like {0,5000}', () => {
    expect(isSafePattern('a{0,5000}').ok).toBe(false);
  });

  test('accepts a truly open-ended {n,} regardless of n: it costs no more than a bare "+"', () => {
    expect(isSafePattern('a{2000,}').ok).toBe(true);
    expect(isSafePattern('\\d{2,}').ok).toBe(true);
    expect(isSafePattern('\\w{4,}').ok).toBe(true);
  });

  test('rejects a malformed regex that fails to compile', () => {
    expect(isSafePattern('(unterminated').ok).toBe(false);
  });

  test('accepts a safe pattern within bounds', () => {
    const result = isSafePattern('\\bERROR\\b');
    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    expect(() => assertSafePattern('\\bERROR\\b')).not.toThrow();
  });

  test('accepts a small bounded quantifier', () => {
    expect(isSafePattern('a{1,3}').ok).toBe(true);
    expect(isSafePattern('a{5}').ok).toBe(true);
  });

  test('rejects a quantifier nested arbitrarily deep, not just one level down', () => {
    const result = isSafePattern('((a+))+');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('nested-quantifier');
  });

  test('rejects an ambiguous alternation with a duplicate branch under a quantifier', () => {
    const result = isSafePattern('(a|a)+');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ambiguous-alternation');
  });

  test('a quantified group with distinct, non-duplicate branches is safe', () => {
    expect(isSafePattern('(GET|POST|PUT)+').ok).toBe(true);
  });

  test('an un-quantified group with duplicate branches is safe (no repetition to blow up)', () => {
    expect(isSafePattern('(a|a)').ok).toBe(true);
  });
});

describe('evaluateCompiled: single match', () => {
  test('one active rule matching selects its lane', () => {
    const rule = literalRule('boom', 'triage');
    const decision = evaluateRules([rule], lineCtx({ line: 'a boom happened' }));
    expect(decision.lane).toBe('triage');
    expect(decision.source).toBe('rule');
    expect(decision.decidingRuleId).toBe(rule.id);
    expect(decision.matches.length).toBe(1);
    expect(decision.matches[0]?.ruleId).toBe(rule.id);
  });

  test('a non-matching rule produces the tier default', () => {
    const rule = literalRule('boom', 'triage');
    const decision = evaluateRules([rule], lineCtx({ line: 'nothing to see here', tier: 1 }));
    expect(decision.source).toBe('default');
    expect(decision.decidingRuleId).toBeNull();
    expect(decision.lane).toBe('batch');
    expect(decision.matches).toEqual([]);
  });
});

describe('evaluateCompiled: multiple matches and precedence', () => {
  test('scope specificity beats lane severity: entity count beats fleet triage', () => {
    const entityRule = literalRule('boom', 'count', { scope: { kind: 'entity', entityId: ENTITY } });
    const fleetRule = literalRule('boom', 'triage', { scope: { kind: 'fleet' } });
    const decision = evaluateRules([fleetRule, entityRule], lineCtx({ line: 'boom' }));
    expect(decision.decidingRuleId).toBe(entityRule.id);
    expect(decision.preClampLane).toBe('count');
  });

  test('conflicting lanes at equal specificity resolve to the higher-priority rule', () => {
    const low = literalRule('boom', 'count', { priority: 0 });
    const high = literalRule('boom', 'batch', { priority: 5 });
    const decision = evaluateRules([low, high], lineCtx({ line: 'boom' }));
    expect(decision.decidingRuleId).toBe(high.id);
    expect(decision.preClampLane).toBe('batch');
  });

  test('equal specificity and priority breaks tie by lane severity', () => {
    const a = literalRule('boom', 'batch');
    const b = literalRule('boom', 'triage');
    const decision = evaluateRules([a, b], lineCtx({ line: 'boom' }));
    expect(decision.decidingRuleId).toBe(b.id);
    expect(decision.preClampLane).toBe('triage');
  });

  test('equal specificity, priority, and lane breaks tie by more recent provenance.updatedAt', () => {
    const older = literalRule('boom', 'batch', {
      provenance: {
        origin: 'operator',
        proposedByRunId: null,
        proposedFromFindingId: null,
        rationale: 'older',
        createdAt: new Date(T0),
        updatedAt: new Date(T0),
        promotedAt: null,
      },
    });
    const newer = literalRule('boom', 'batch', {
      provenance: {
        origin: 'operator',
        proposedByRunId: null,
        proposedFromFindingId: null,
        rationale: 'newer',
        createdAt: new Date(T0),
        updatedAt: new Date(T0 + 10_000),
        promotedAt: null,
      },
    });
    const decision = evaluateRules([older, newer], lineCtx({ line: 'boom' }));
    expect(decision.decidingRuleId).toBe(newer.id);
  });

  test('equal specificity, priority, lane, and updatedAt breaks tie by ruleId ascending', () => {
    const provenance = {
      origin: 'operator' as const,
      proposedByRunId: null,
      proposedFromFindingId: null,
      rationale: 'tie',
      createdAt: new Date(T0),
      updatedAt: new Date(T0),
      promotedAt: null,
    };
    const second = literalRule('boom', 'batch', { id: 'z-rule', provenance });
    const first = literalRule('boom', 'batch', { id: 'a-rule', provenance });
    const decision = evaluateRules([second, first], lineCtx({ line: 'boom' }));
    expect(decision.decidingRuleId).toBe('a-rule');

    const reversed = evaluateRules([first, second], lineCtx({ line: 'boom' }));
    expect(reversed.decidingRuleId).toBe('a-rule');
  });

  test('matches array reflects full active resolution order, most specific first', () => {
    const fleetRule = literalRule('boom', 'batch', { scope: { kind: 'fleet' } });
    const hostRule = literalRule('boom', 'batch', { scope: { kind: 'host', host: HOST } });
    const entityRule = literalRule('boom', 'batch', { scope: { kind: 'entity', entityId: ENTITY } });
    const decision = evaluateRules([fleetRule, hostRule, entityRule], lineCtx({ line: 'boom' }));
    expect(decision.matches.map((m) => m.ruleId)).toEqual([entityRule.id, hostRule.id, fleetRule.id]);
  });

  test('re-sorting decision.matches with the exported compareRuleMatches reproduces the same order the engine picked', () => {
    const aLow = literalRule('boom', 'triage', { id: 'a-rule', priority: 0 });
    const bHigh = literalRule('boom', 'count', { id: 'b-rule', priority: 100 });
    const decision = evaluateRules([aLow, bHigh], lineCtx({ line: 'boom' }));
    expect(decision.decidingRuleId).toBe('b-rule');
    expect(decision.preClampLane).toBe('count');

    const resorted = [...decision.matches].sort(compareRuleMatches);
    expect(resorted.map((m) => m.ruleId)).toEqual(decision.matches.map((m) => m.ruleId));
    expect(resorted[0]?.ruleId).toBe('b-rule');
  });
});

describe('evaluateCompiled: retired and non-evaluable states', () => {
  test('a retired rule is ignored entirely', () => {
    const retired = literalRule('boom', 'triage', { state: 'retired' });
    const decision = evaluateRules([retired], lineCtx({ line: 'boom', tier: 1 }));
    expect(decision.source).toBe('default');
    expect(decision.matches).toEqual([]);
    expect(decision.shadow).toEqual([]);
  });

  test('a proposed rule is never evaluated', () => {
    const proposed = literalRule('boom', 'triage', { state: 'proposed' });
    const decision = evaluateRules([proposed], lineCtx({ line: 'boom', tier: 1 }));
    expect(decision.source).toBe('default');
    expect(decision.matches).toEqual([]);
    expect(decision.shadow).toEqual([]);
  });

  test('a rejected rule is never evaluated', () => {
    const rejected = literalRule('boom', 'triage', { state: 'rejected' });
    const decision = evaluateRules([rejected], lineCtx({ line: 'boom', tier: 1 }));
    expect(decision.matches).toEqual([]);
    expect(decision.shadow).toEqual([]);
  });

  test('a disabled active rule is ignored', () => {
    const disabled = literalRule('boom', 'triage', { enabled: false });
    const decision = evaluateRules([disabled], lineCtx({ line: 'boom', tier: 1 }));
    expect(decision.matches).toEqual([]);
  });
});

describe('evaluateCompiled: shadow rules', () => {
  test('shadow rules are evaluated and recorded but never selected for dispatch', () => {
    const active = literalRule('boom', 'batch');
    const shadow = literalRule('boom', 'page', { state: 'shadow' });
    const decision = evaluateRules([active, shadow], lineCtx({ line: 'boom', tier: 1 }));
    expect(decision.lane).toBe('batch');
    expect(decision.decidingRuleId).toBe(active.id);
    expect(decision.matches.map((m) => m.ruleId)).toEqual([active.id]);
    expect(decision.shadow.length).toBe(1);
    expect(decision.shadow[0]?.ruleId).toBe(shadow.id);
  });

  test('wouldChangeLane is true when the shadow rule would move the resolved lane', () => {
    const active = literalRule('boom', 'batch');
    const shadow = literalRule('boom', 'triage', {
      state: 'shadow',
      scope: { kind: 'entity', entityId: ENTITY },
    });
    const decision = evaluateRules([active, shadow], lineCtx({ line: 'boom', tier: 1 }));
    expect(decision.shadow[0]?.wouldBeLane).toBe('triage');
    expect(decision.shadow[0]?.wouldChangeLane).toBe(true);
  });

  test('wouldChangeLane is false when the shadow rule agrees with the active decision', () => {
    const active = literalRule('boom', 'batch');
    const shadow = literalRule('boom', 'batch', { state: 'shadow', scope: { kind: 'entity', entityId: ENTITY } });
    const decision = evaluateRules([active, shadow], lineCtx({ line: 'boom', tier: 1 }));
    expect(decision.shadow[0]?.wouldBeLane).toBe('batch');
    expect(decision.shadow[0]?.wouldChangeLane).toBe(false);
  });

  test('a shadow rule can be the sole match, producing a counterfactual against the default lane', () => {
    const shadow = literalRule('boom', 'page', { state: 'shadow' });
    const decision = evaluateRules([shadow], lineCtx({ line: 'boom', tier: 1 }));
    expect(decision.source).toBe('default');
    expect(decision.lane).toBe('batch');
    expect(decision.shadow.length).toBe(1);
    expect(decision.shadow[0]?.wouldBeLane).toBe('triage');
    expect(decision.shadow[0]?.wouldChangeLane).toBe(true);
  });

  test('counterfactuals beyond MAX_SHADOW_COUNTERFACTUALS fall back to the rule own lane and set truncatedShadow', () => {
    const active = literalRule('boom', 'batch');
    const shadowRules = Array.from({ length: MAX_SHADOW_COUNTERFACTUALS + 3 }, (_, i) =>
      literalRule('boom', 'triage', { state: 'shadow', id: `shadow-${i}`, priority: i }),
    );
    const decision = evaluateRules([active, ...shadowRules], lineCtx({ line: 'boom', tier: 1 }));
    expect(decision.shadow.length).toBe(shadowRules.length);
    expect(decision.truncatedShadow).toBe(true);
    const last = decision.shadow[decision.shadow.length - 1];
    expect(last?.wouldBeLane).toBe('triage');
  });
});

describe('discard is impossible: count is the floor', () => {
  test('the resolved lane is always one of the four lanes, never a discard value', () => {
    const scenarios: DetectorRule[][] = [
      [],
      [literalRule('boom', 'count')],
      [literalRule('boom', 'batch'), literalRule('boom', 'triage', { state: 'shadow' })],
      [literalRule('boom', 'page', { state: 'retired' })],
    ];
    for (const tier of [0, 1, 2] as const) {
      for (const coldStart of [false, true]) {
        for (const rules of scenarios) {
          const decision = evaluateRules(rules, lineCtx({ line: 'boom', tier, coldStart }));
          expect(LOG_LANES).toContain(decision.lane);
          expect(decision.lane).not.toBe('discard' as LogLane);
        }
      }
    }
  });

  test('an unmatched line at every tier still resolves to a real lane, never nothing', () => {
    for (const tier of [0, 1, 2] as const) {
      for (const coldStart of [false, true]) {
        const decision = evaluateRules([], lineCtx({ line: 'unrecognized line', tier, coldStart }));
        expect(LOG_LANES).toContain(decision.lane);
        expect(decision.source).toBe('default');
      }
    }
  });
});

describe('clampLane: each clamp in isolation', () => {
  test('page requires tier 0', () => {
    const result = clampLane('page', lineCtx({ tier: 1 }), null, []);
    expect(result.lane).toBe('triage');
    expect(result.reasons).toContain('page-requires-tier0');
  });

  test('page is left alone at tier 0', () => {
    const result = clampLane('page', lineCtx({ tier: 0 }), null, []);
    expect(result.lane).toBe('page');
    expect(result.clamped).toBe(false);
  });

  test('hard-signal floor raises a low lane when a hard-signal rule matched', () => {
    const hardMatch = {
      ruleId: 'hard',
      ruleVersion: 1,
      kind: 'match' as const,
      lane: 'count' as const,
      scopeSpecificity: 1,
      priority: 0,
      updatedAt: 0,
      hardSignal: true,
      isCanary: false,
      evidence: { matchedText: null, metric: null, observed: null, expected: null, z: null },
    };
    const result = clampLane('count', lineCtx({ tier: 1 }), null, [hardMatch]);
    expect(result.lane).toBe('triage');
    expect(result.reasons).toContain('hard-signal-floor');
  });

  test('hard-signal floor is skipped when the deciding rule is operator approved', () => {
    const hardMatch = {
      ruleId: 'hard',
      ruleVersion: 1,
      kind: 'match' as const,
      lane: 'count' as const,
      scopeSpecificity: 1,
      priority: 0,
      updatedAt: 0,
      hardSignal: true,
      isCanary: false,
      evidence: { matchedText: null, metric: null, observed: null, expected: null, z: null },
    };
    const decidingRule = literalRule('x', 'count', { operatorApproved: true });
    const result = clampLane('count', lineCtx({ tier: 1 }), decidingRule, [hardMatch]);
    expect(result.reasons).not.toContain('hard-signal-floor');
    expect(result.lane).toBe('count');
  });

  test('tier-0 demotion floor raises a low lane on tier 0 when warm', () => {
    const result = clampLane('count', lineCtx({ tier: 0, coldStart: false }), null, []);
    expect(result.lane).toBe('triage');
    expect(result.reasons).toContain('tier0-demotion-requires-approval');
  });

  test('tier-0 demotion floor does not fire during cold start', () => {
    const result = clampLane('count', lineCtx({ tier: 0, coldStart: true }), null, []);
    expect(result.reasons).not.toContain('tier0-demotion-requires-approval');
    expect(result.lane).toBe('count');
  });

  test('tier-0 demotion floor is skipped when the deciding rule is operator approved', () => {
    const decidingRule = literalRule('x', 'count', { operatorApproved: true });
    const result = clampLane('count', lineCtx({ tier: 0, coldStart: false }), decidingRule, []);
    expect(result.reasons).not.toContain('tier0-demotion-requires-approval');
    expect(result.lane).toBe('count');
  });

  test('fleet-scope demotion raises to the tier default when unapproved', () => {
    const decidingRule = literalRule('x', 'count', { scope: { kind: 'fleet' }, operatorApproved: false });
    const result = clampLane('count', lineCtx({ tier: 1, coldStart: false }), decidingRule, []);
    expect(result.lane).toBe('batch');
    expect(result.reasons).toContain('fleet-demotion-requires-approval');
  });

  test('fleet-scope demotion is skipped when operator approved', () => {
    const decidingRule = literalRule('x', 'count', { scope: { kind: 'fleet' }, operatorApproved: true });
    const result = clampLane('count', lineCtx({ tier: 1, coldStart: false }), decidingRule, []);
    expect(result.lane).toBe('count');
    expect(result.reasons).not.toContain('fleet-demotion-requires-approval');
  });

  test('fleet-scope demotion does not apply to a non-fleet deciding rule', () => {
    const decidingRule = literalRule('x', 'count', { scope: { kind: 'entity', entityId: ENTITY } });
    const result = clampLane('count', lineCtx({ tier: 1, coldStart: false }), decidingRule, []);
    expect(result.reasons).not.toContain('fleet-demotion-requires-approval');
  });

  test('no clamp applies to a lane already above every floor', () => {
    const result = clampLane('page', lineCtx({ tier: 0, coldStart: false }), null, []);
    expect(result.clamped).toBe(false);
    expect(result.reasons).toEqual([]);
  });
});

describe('hard-signal floor blocks demotion of a seeded hard-signal rule', () => {
  test('an agent shadow rule demoting seed:oom-killed to count never wins dispatch', () => {
    const oomKilled = SEEDED_RULES.find((r) => r.id === 'seed:oom-killed');
    if (!oomKilled) throw new Error('seed:oom-killed missing from SEEDED_RULES');
    const demotion = makeRule({
      id: 'agent:demote-oom',
      matcher: { type: 'event', eventTypes: [] },
      lane: 'count',
      kind: 'state',
      scope: { kind: 'entity', entityId: ENTITY },
      priority: 100,
      operatorApproved: false,
    });
    const ctx = eventCtx({ tier: 1, event: makeEvent({ eventType: 'die', oomKilled: true }) });
    const decision = evaluateRules([oomKilled, demotion], ctx);
    expect(decision.decidingRuleId).toBe(demotion.id);
    expect(decision.preClampLane).toBe('count');
    expect(decision.lane).toBe('triage');
    expect(decision.clampReasons).toContain('hard-signal-floor');
  });
});

describe('threshold matcher', () => {
  test('absolute comparison matches without needing a baseline verdict', () => {
    const rule = makeRule({
      matcher: { type: 'threshold', metric: 'lineCount', comparison: 'absolute', value: 100, windowMs: 60_000 },
      lane: 'batch',
      kind: 'threshold',
    });
    const ctx = tickCtx({ metrics: makeMetrics({ lineCount: 150 }) });
    const decision = evaluateRules([rule], ctx);
    expect(decision.decidingRuleId).toBe(rule.id);
  });

  test('absolute comparison reads stderrCount and stderrRatio metrics directly', () => {
    const stderrRule = makeRule({
      matcher: { type: 'threshold', metric: 'stderrCount', comparison: 'absolute', value: 10, windowMs: 60_000 },
      lane: 'batch',
      kind: 'threshold',
    });
    const stderrDecision = evaluateRules([stderrRule], tickCtx({ metrics: makeMetrics({ stderrCount: 20 }) }));
    expect(stderrDecision.decidingRuleId).toBe(stderrRule.id);

    const ratioRule = makeRule({
      matcher: { type: 'threshold', metric: 'stderrRatio', comparison: 'absolute', value: 0.5, windowMs: 60_000 },
      lane: 'batch',
      kind: 'threshold',
    });
    const ratioDecision = evaluateRules([ratioRule], tickCtx({ metrics: makeMetrics({ stderrRatio: 0.8 }) }));
    expect(ratioDecision.decidingRuleId).toBe(ratioRule.id);
  });

  test('absolute comparison below value does not match', () => {
    const rule = makeRule({
      matcher: { type: 'threshold', metric: 'lineCount', comparison: 'absolute', value: 100, windowMs: 60_000 },
      lane: 'batch',
      kind: 'threshold',
    });
    const ctx = tickCtx({ metrics: makeMetrics({ lineCount: 50 }), tier: 1 });
    const decision = evaluateRules([rule], ctx);
    expect(decision.source).toBe('default');
  });

  test('zScore comparison reads verdict.z and ignores raw counts', () => {
    const rule = makeRule({
      matcher: { type: 'threshold', metric: 'stderrCount', comparison: 'zScore', value: 4, windowMs: 60_000 },
      lane: 'triage',
      kind: 'threshold',
    });
    const ctx = tickCtx({ metrics: makeMetrics({ verdicts: { lines: null, stderr: makeVerdict({ z: 5 }), stderrRatio: null } }) });
    const decision = evaluateRules([rule], ctx);
    expect(decision.decidingRuleId).toBe(rule.id);
  });

  test('zScore comparison below value does not match', () => {
    const rule = makeRule({
      matcher: { type: 'threshold', metric: 'stderrCount', comparison: 'zScore', value: 4, windowMs: 60_000 },
      lane: 'triage',
      kind: 'threshold',
    });
    const ctx = tickCtx({
      metrics: makeMetrics({ verdicts: { lines: null, stderr: makeVerdict({ z: 1 }), stderrRatio: null } }),
      tier: 1,
    });
    const decision = evaluateRules([rule], ctx);
    expect(decision.source).toBe('default');
  });

  test('baselineMultiple comparison reads verdict.ratio', () => {
    const rule = makeRule({
      matcher: { type: 'threshold', metric: 'stderrRatio', comparison: 'baselineMultiple', value: 3, windowMs: 60_000 },
      lane: 'triage',
      kind: 'threshold',
    });
    const ctx = tickCtx({
      metrics: makeMetrics({ verdicts: { lines: null, stderr: null, stderrRatio: makeVerdict({ ratio: 4 }) } }),
    });
    const decision = evaluateRules([rule], ctx);
    expect(decision.decidingRuleId).toBe(rule.id);
  });

  test('a threshold rule with a null verdict is suppressed as baseline-cold, not matched', () => {
    const rule = makeRule({
      matcher: { type: 'threshold', metric: 'stderrCount', comparison: 'zScore', value: 4, windowMs: 60_000 },
      lane: 'triage',
      kind: 'threshold',
    });
    const ctx = tickCtx({ metrics: makeMetrics({ verdicts: { lines: null, stderr: null, stderrRatio: null } }), tier: 1 });
    const decision = evaluateRules([rule], ctx);
    expect(decision.source).toBe('default');
    expect(decision.suppressed).toEqual([{ ruleId: rule.id, reason: 'baseline-cold' }]);
  });

  test('a threshold rule with an untrusted (cold-start) verdict is suppressed even though ratio/z clear the bar', () => {
    const rule = makeRule({
      matcher: {
        type: 'threshold',
        metric: 'stderrCount',
        comparison: 'baselineMultiple',
        value: 2,
        windowMs: 120_000,
        sinceImageChangeMaxMs: 900_000,
      },
      lane: 'triage',
      kind: 'threshold',
      hardSignal: true,
    });
    const coldVerdict = makeVerdict({ ratio: 3.65, z: 0.726, verdict: 'normal', reason: 'cold-start', trusted: false });
    const ctx = tickCtx({
      metrics: makeMetrics({ verdicts: { lines: null, stderr: coldVerdict, stderrRatio: null } }),
      tier: 1,
      sinceImageChangeMs: 60_000,
    });
    const decision = evaluateRules([rule], ctx);
    expect(decision.source).toBe('default');
    expect(decision.suppressed).toEqual([{ ruleId: rule.id, reason: 'baseline-cold' }]);
  });

  test('shapeCount metric reads the named shape counter', () => {
    const rule = makeRule({
      matcher: {
        type: 'threshold',
        metric: 'shapeCount',
        comparison: 'absolute',
        value: 10,
        windowMs: 60_000,
        shapeId: 'shape-x',
      },
      lane: 'batch',
      kind: 'threshold',
    });
    const ctx = tickCtx({ metrics: makeMetrics({ shapeCounts: new Map([['shape-x', 20]]) }) });
    const decision = evaluateRules([rule], ctx);
    expect(decision.decidingRuleId).toBe(rule.id);
  });

  test('shapeCount metric without a shapeId never matches', () => {
    const rule = makeRule({
      matcher: { type: 'threshold', metric: 'shapeCount', comparison: 'absolute', value: 1, windowMs: 60_000 },
      lane: 'batch',
      kind: 'threshold',
    });
    const ctx = tickCtx({ metrics: makeMetrics({ shapeCounts: new Map([['shape-x', 20]]) }), tier: 1 });
    const decision = evaluateRules([rule], ctx);
    expect(decision.source).toBe('default');
  });

  test('shapeCount metric with baselineMultiple comparison has no verdict source and is suppressed', () => {
    const rule = makeRule({
      matcher: {
        type: 'threshold',
        metric: 'shapeCount',
        comparison: 'baselineMultiple',
        value: 2,
        windowMs: 60_000,
        shapeId: 'shape-x',
      },
      lane: 'batch',
      kind: 'threshold',
    });
    const ctx = tickCtx({ metrics: makeMetrics({ shapeCounts: new Map([['shape-x', 20]]) }), tier: 1 });
    const decision = evaluateRules([rule], ctx);
    expect(decision.suppressed).toEqual([{ ruleId: rule.id, reason: 'baseline-cold' }]);
  });

  test('sinceImageChangeMaxMs gates the rule to the post-deploy window', () => {
    const rule = makeRule({
      matcher: {
        type: 'threshold',
        metric: 'stderrCount',
        comparison: 'baselineMultiple',
        value: 2,
        windowMs: 120_000,
        sinceImageChangeMaxMs: 900_000,
      },
      lane: 'triage',
      kind: 'threshold',
      hardSignal: true,
    });
    const metrics = makeMetrics({ verdicts: { lines: null, stderr: makeVerdict({ ratio: 5 }), stderrRatio: null } });

    const inWindow = evaluateRules([rule], tickCtx({ metrics, sinceImageChangeMs: 100_000 }));
    expect(inWindow.decidingRuleId).toBe(rule.id);

    const outsideWindow = evaluateRules([rule], tickCtx({ metrics, sinceImageChangeMs: 1_000_000, tier: 1 }));
    expect(outsideWindow.source).toBe('default');

    const noImageChange = evaluateRules([rule], tickCtx({ metrics, sinceImageChangeMs: null, tier: 1 }));
    expect(noImageChange.source).toBe('default');
  });
});

describe('silence matcher', () => {
  test('matches when the silence verdict is anomalous for the same window', () => {
    const rule = makeRule({ matcher: { type: 'silence', windowMs: 300_000 }, lane: 'triage', kind: 'silence' });
    const ctx = tickCtx({ metrics: makeMetrics({ silence: makeSilence({ windowMs: 300_000 }) }) });
    const decision = evaluateRules([rule], ctx);
    expect(decision.decidingRuleId).toBe(rule.id);
  });

  test('does not match a normal silence verdict', () => {
    const rule = makeRule({ matcher: { type: 'silence', windowMs: 300_000 }, lane: 'triage', kind: 'silence' });
    const ctx = tickCtx({
      metrics: makeMetrics({ silence: makeSilence({ windowMs: 300_000, verdict: 'normal' }) }),
      tier: 1,
    });
    const decision = evaluateRules([rule], ctx);
    expect(decision.source).toBe('default');
  });

  test('does not match when the metrics carry no silence verdict', () => {
    const rule = makeRule({ matcher: { type: 'silence', windowMs: 300_000 }, lane: 'triage', kind: 'silence' });
    const decision = evaluateRules([rule], tickCtx({ tier: 1 }));
    expect(decision.source).toBe('default');
  });

  test('does not match when the silence window differs from the matcher window', () => {
    const rule = makeRule({ matcher: { type: 'silence', windowMs: 300_000 }, lane: 'triage', kind: 'silence' });
    const ctx = tickCtx({ metrics: makeMetrics({ silence: makeSilence({ windowMs: 60_000 }) }), tier: 1 });
    const decision = evaluateRules([rule], ctx);
    expect(decision.source).toBe('default');
  });
});

describe('event matcher', () => {
  test('eventTypes restricts which event type can match', () => {
    const rule = makeRule({
      matcher: { type: 'event', eventTypes: ['die'] },
      lane: 'triage',
      kind: 'state',
    });
    const matched = evaluateRules([rule], eventCtx({ event: makeEvent({ eventType: 'die' }) }));
    expect(matched.decidingRuleId).toBe(rule.id);

    const unmatched = evaluateRules([rule], eventCtx({ event: makeEvent({ eventType: 'start' }), tier: 1 }));
    expect(unmatched.source).toBe('default');
  });

  test('empty eventTypes applies to any event type', () => {
    const rule = makeRule({ matcher: { type: 'event', eventTypes: [] }, lane: 'triage', kind: 'state' });
    const decision = evaluateRules([rule], eventCtx({ event: makeEvent({ eventType: 'health_status' }) }));
    expect(decision.decidingRuleId).toBe(rule.id);
  });

  test('oomKilled must equal the matcher value', () => {
    const rule = makeRule({ matcher: { type: 'event', eventTypes: [], oomKilled: true }, lane: 'page', kind: 'state' });
    const matched = evaluateRules([rule], eventCtx({ tier: 0, event: makeEvent({ oomKilled: true }) }));
    expect(matched.decidingRuleId).toBe(rule.id);

    const unmatched = evaluateRules([rule], eventCtx({ tier: 1, event: makeEvent({ oomKilled: false }) }));
    expect(unmatched.source).toBe('default');
  });

  test('exitCodeNonZero true requires a non-null, non-zero exit code', () => {
    const rule = makeRule({
      matcher: { type: 'event', eventTypes: [], exitCodeNonZero: true },
      lane: 'triage',
      kind: 'state',
    });
    const matched = evaluateRules([rule], eventCtx({ event: makeEvent({ exitCode: 1 }) }));
    expect(matched.decidingRuleId).toBe(rule.id);

    const zeroExit = evaluateRules([rule], eventCtx({ tier: 1, event: makeEvent({ exitCode: 0 }) }));
    expect(zeroExit.source).toBe('default');

    const nullExit = evaluateRules([rule], eventCtx({ tier: 1, event: makeEvent({ exitCode: null }) }));
    expect(nullExit.source).toBe('default');
  });

  test('healthStatus must match exactly', () => {
    const rule = makeRule({
      matcher: { type: 'event', eventTypes: [], healthStatus: 'unhealthy' },
      lane: 'triage',
      kind: 'state',
    });
    const matched = evaluateRules([rule], eventCtx({ event: makeEvent({ healthStatus: 'unhealthy' }) }));
    expect(matched.decidingRuleId).toBe(rule.id);

    const unmatched = evaluateRules([rule], eventCtx({ tier: 1, event: makeEvent({ healthStatus: 'starting' }) }));
    expect(unmatched.source).toBe('default');
  });

  test('minRestartsInWindow requires at least that many restarts', () => {
    const rule = makeRule({
      matcher: { type: 'event', eventTypes: [], minRestartsInWindow: 3, windowMs: 600_000 },
      lane: 'page',
      kind: 'state',
    });
    const matched = evaluateRules([rule], eventCtx({ tier: 0, event: makeEvent({ restartsInWindow: 3 }) }));
    expect(matched.decidingRuleId).toBe(rule.id);

    const unmatched = evaluateRules([rule], eventCtx({ tier: 1, event: makeEvent({ restartsInWindow: 2 }) }));
    expect(unmatched.source).toBe('default');
  });
});

describe('literal and regex matchers', () => {
  test('literal matcher on raw is case sensitive when configured', () => {
    const rule = makeRule({
      matcher: { type: 'literal', needle: 'Boom', caseSensitive: true, target: 'raw', stream: 'any' },
      lane: 'batch',
      kind: 'match',
    });
    const matched = evaluateRules([rule], lineCtx({ line: 'a Boom happened' }));
    expect(matched.decidingRuleId).toBe(rule.id);

    const unmatched = evaluateRules([rule], lineCtx({ line: 'a boom happened', tier: 1 }));
    expect(unmatched.source).toBe('default');
  });

  test('literal matcher is case insensitive when configured', () => {
    const rule = makeRule({
      matcher: { type: 'literal', needle: 'Boom', caseSensitive: false, target: 'raw', stream: 'any' },
      lane: 'batch',
      kind: 'match',
    });
    const decision = evaluateRules([rule], lineCtx({ line: 'a BOOM happened' }));
    expect(decision.decidingRuleId).toBe(rule.id);
  });

  test('literal matcher on template reads the normalized shape', () => {
    const rule = makeRule({
      matcher: { type: 'literal', needle: '<N> frames', caseSensitive: true, target: 'template', stream: 'any' },
      lane: 'batch',
      kind: 'match',
    });
    const ctx = lineCtx({ line: 'dropped 47 frames', shape: makeShape('s', 'dropped <N> frames') });
    const decision = evaluateRules([rule], ctx);
    expect(decision.decidingRuleId).toBe(rule.id);
  });

  test('stream filter restricts a literal matcher to stderr', () => {
    const rule = makeRule({
      matcher: { type: 'literal', needle: 'boom', caseSensitive: true, target: 'raw', stream: 'stderr' },
      lane: 'batch',
      kind: 'match',
    });
    const stdout = evaluateRules([rule], lineCtx({ line: 'boom', stream: 'stdout', tier: 1 }));
    expect(stdout.source).toBe('default');

    const stderr = evaluateRules([rule], lineCtx({ line: 'boom', stream: 'stderr' }));
    expect(stderr.decidingRuleId).toBe(rule.id);
  });

  test('regex matcher captures the matched substring as evidence', () => {
    const rule = makeRule({
      matcher: { type: 'regex', pattern: '\\bERR\\d+\\b', flags: '', target: 'raw', stream: 'any' },
      lane: 'triage',
      kind: 'match',
    });
    const decision = evaluateRules([rule], lineCtx({ line: 'saw ERR42 today' }));
    expect(decision.matches[0]?.evidence.matchedText).toBe('ERR42');
  });

  test('regex matcher stream filter blocks a non-matching stream', () => {
    const rule = makeRule({
      matcher: { type: 'regex', pattern: 'boom', flags: '', target: 'raw', stream: 'stderr' },
      lane: 'batch',
      kind: 'match',
    });
    const decision = evaluateRules([rule], lineCtx({ line: 'boom', stream: 'stdout', tier: 1 }));
    expect(decision.source).toBe('default');
  });

  test('regex matcher with no compiled regex never matches', () => {
    const rule = makeRule({
      matcher: { type: 'regex', pattern: 'boom', flags: '', target: 'raw', stream: 'any' },
      lane: 'batch',
      kind: 'match',
    });
    const compiled = compileRule(rule);
    const forcedNullRegex = { ...compiled, regex: null };
    const set = { rules: [forcedNullRegex], byTrigger: { line: [forcedNullRegex], tick: [], event: [] }, invalid: [] };
    const decision = evaluateCompiled(set, lineCtx({ line: 'boom', tier: 1 }));
    expect(decision.source).toBe('default');
  });

  test('regex matcher that compiles but does not find the pattern in the line', () => {
    const rule = makeRule({
      matcher: { type: 'regex', pattern: '\\bZZZTOP\\b', flags: '', target: 'raw', stream: 'any' },
      lane: 'batch',
      kind: 'match',
    });
    const decision = evaluateRules([rule], lineCtx({ line: 'nothing relevant here', tier: 1 }));
    expect(decision.source).toBe('default');
  });

  test('regex matcher on template with a stream filter', () => {
    const rule = makeRule({
      matcher: { type: 'regex', pattern: '<N>:<N>', flags: '', target: 'template', stream: 'stdout' },
      lane: 'batch',
      kind: 'match',
    });
    const ctx = lineCtx({ shape: makeShape('s', 'stream <N>:<N> dropped'), stream: 'stdout' });
    const decision = evaluateRules([rule], ctx);
    expect(decision.decidingRuleId).toBe(rule.id);
  });

  test('a line longer than MAX_LINE_MATCH_CHARS is truncated before matching', () => {
    const needle = 'NEEDLE';
    const longLine = 'x'.repeat(MAX_LINE_MATCH_CHARS + 500) + needle;
    const rule = makeRule({
      matcher: { type: 'literal', needle, caseSensitive: true, target: 'raw', stream: 'any' },
      lane: 'batch',
      kind: 'match',
    });
    const decision = evaluateRules([rule], lineCtx({ line: longLine, tier: 1 }));
    expect(decision.source).toBe('default');
  });

  test('an unsafe compiled pattern that fails to build still produces no match', () => {
    const compiledMissingRegex = literalRule('x', 'batch');
    const compiled = compileRule(compiledMissingRegex);
    const forcedNullRegex = { ...compiled, regex: null };
    const set = { rules: [forcedNullRegex], byTrigger: { line: [], tick: [], event: [] }, invalid: [] };
    expect(evaluateCompiled(set, lineCtx()).source).toBe('default');
  });
});

describe('shape matcher', () => {
  test('matches when the line shapeId is in the configured set', () => {
    const rule = makeRule({ matcher: { type: 'shape', shapeIds: ['shape-a', 'shape-b'] }, lane: 'batch', kind: 'route' });
    const decision = evaluateRules([rule], lineCtx({ shape: makeShape('shape-a') }));
    expect(decision.decidingRuleId).toBe(rule.id);
    expect(decision.matches[0]?.evidence.matchedText).toBe('plain line');
  });

  test('does not match when the shapeId is not in the set', () => {
    const rule = makeRule({ matcher: { type: 'shape', shapeIds: ['shape-a'] }, lane: 'batch', kind: 'route' });
    const decision = evaluateRules([rule], lineCtx({ shape: makeShape('shape-z'), tier: 1 }));
    expect(decision.source).toBe('default');
  });
});

describe('correlate matcher', () => {
  test('fires only when every required rule has a recent match within the window', () => {
    const a = literalRule('alpha', 'count', { id: 'r-a' });
    const b = literalRule('beta', 'count', { id: 'r-b' });
    const correlate = makeRule({
      matcher: { type: 'correlate', ruleIds: ['r-a', 'r-b'], windowMs: 60_000 },
      lane: 'triage',
      kind: 'correlate',
      scope: { kind: 'entity', entityId: ENTITY },
    });
    const recentRuleMatches = new Map<string, readonly number[]>([['r-a', [T0 - 1_000]]]);
    const decision = evaluateRules([a, b, correlate], lineCtx({ line: 'beta fired', recentRuleMatches }));
    expect(decision.matches.some((m) => m.ruleId === correlate.id)).toBe(true);
  });

  test('does not fire when a required rule has no recent match', () => {
    const correlate = makeRule({
      matcher: { type: 'correlate', ruleIds: ['missing-rule'], windowMs: 60_000 },
      lane: 'triage',
      kind: 'correlate',
    });
    const decision = evaluateRules([correlate], lineCtx({ line: 'anything', tier: 1 }));
    expect(decision.matches.some((m) => m.ruleId === correlate.id)).toBe(false);
  });

  test('does not fire when the recent match falls outside the window', () => {
    const correlate = makeRule({
      matcher: { type: 'correlate', ruleIds: ['r-a'], windowMs: 1_000 },
      lane: 'triage',
      kind: 'correlate',
    });
    const recentRuleMatches = new Map<string, readonly number[]>([['r-a', [T0 - 5_000]]]);
    const decision = evaluateRules([correlate], lineCtx({ line: 'nothing here', recentRuleMatches, tier: 1 }));
    expect(decision.matches.some((m) => m.ruleId === correlate.id)).toBe(false);
  });

  test('an active correlate rule does not fire off a same-line shadow rule match', () => {
    const shadowB = literalRule('beta', 'count', { id: 'shadow-b', state: 'shadow' });
    const activeC = makeRule({
      id: 'active-c',
      matcher: { type: 'correlate', ruleIds: ['shadow-b'], windowMs: 60_000 },
      lane: 'page',
      kind: 'correlate',
      state: 'active',
    });
    const decision = evaluateRules([shadowB, activeC], lineCtx({ line: 'beta fired' }));
    expect(decision.shadow.some((m) => m.ruleId === 'shadow-b')).toBe(true);
    expect(decision.matches.some((m) => m.ruleId === 'active-c')).toBe(false);
    expect(decision.decidingRuleId).not.toBe('active-c');
  });

  test('a shadow correlate rule can still fire off a same-line shadow rule match (counterfactual visibility is unaffected)', () => {
    const shadowB = literalRule('beta', 'count', { id: 'shadow-b', state: 'shadow' });
    const shadowC = makeRule({
      id: 'shadow-c',
      matcher: { type: 'correlate', ruleIds: ['shadow-b'], windowMs: 60_000 },
      lane: 'page',
      kind: 'correlate',
      state: 'shadow',
    });
    const decision = evaluateRules([shadowB, shadowC], lineCtx({ line: 'beta fired' }));
    expect(decision.shadow.some((m) => m.ruleId === 'shadow-c')).toBe(true);
  });
});

describe('cold start', () => {
  test('suppresses a non-hard-signal threshold rule and records the reason', () => {
    const rule = makeRule({
      matcher: { type: 'threshold', metric: 'lineCount', comparison: 'absolute', value: 1, windowMs: 60_000 },
      lane: 'batch',
      kind: 'threshold',
    });
    const ctx = tickCtx({ coldStart: true, metrics: makeMetrics({ lineCount: 100 }) });
    const decision = evaluateRules([rule], ctx);
    expect(decision.source).toBe('default');
    expect(decision.suppressed).toEqual([{ ruleId: rule.id, reason: 'cold-start' }]);
  });

  test('suppresses a non-hard-signal silence rule', () => {
    const rule = makeRule({ matcher: { type: 'silence', windowMs: 300_000 }, lane: 'triage', kind: 'silence' });
    const ctx = tickCtx({ coldStart: true, metrics: makeMetrics({ silence: makeSilence() }) });
    const decision = evaluateRules([rule], ctx);
    expect(decision.suppressed).toEqual([{ ruleId: rule.id, reason: 'cold-start' }]);
  });

  test('does not suppress a hard-signal rule', () => {
    const rule = literalRule('boom', 'triage', { hardSignal: true });
    const decision = evaluateRules([rule], lineCtx({ line: 'boom', coldStart: true }));
    expect(decision.decidingRuleId).toBe(rule.id);
    expect(decision.suppressed).toEqual([]);
  });

  test('the default lane during cold start on tier 0 is batch, not triage', () => {
    const decision = evaluateRules([], lineCtx({ line: 'startup chatter', tier: 0, coldStart: true }));
    expect(decision.lane).toBe('batch');
    expect(decision.source).toBe('default');
  });

  test('suppressed list is capped at MAX_SUPPRESSED_RECORDED', () => {
    const rules = Array.from({ length: MAX_SUPPRESSED_RECORDED + 5 }, (_, i) =>
      literalRule('boom', 'batch', { id: `soft-${i}` }),
    );
    const decision = evaluateRules(rules, lineCtx({ line: 'boom', coldStart: true, tier: 1 }));
    expect(decision.suppressed.length).toBe(MAX_SUPPRESSED_RECORDED);
  });
});

describe('canary marker', () => {
  test('isCanary is true while the evaluation time is before canaryUntil', () => {
    const rule = literalRule('boom', 'batch', { canaryUntil: new Date(T0 + 60_000) });
    const decision = evaluateRules([rule], lineCtx({ line: 'boom', at: T0 }));
    expect(decision.matches[0]?.isCanary).toBe(true);
  });

  test('isCanary is false once past canaryUntil', () => {
    const rule = literalRule('boom', 'batch', { canaryUntil: new Date(T0 - 60_000) });
    const decision = evaluateRules([rule], lineCtx({ line: 'boom', at: T0 }));
    expect(decision.matches[0]?.isCanary).toBe(false);
  });

  test('isCanary is false when canaryUntil is null', () => {
    const rule = literalRule('boom', 'batch', { canaryUntil: null });
    const decision = evaluateRules([rule], lineCtx({ line: 'boom' }));
    expect(decision.matches[0]?.isCanary).toBe(false);
  });
});

describe('shapeId on the decision', () => {
  test('carries the shapeId for a line trigger', () => {
    const decision = evaluateRules([], lineCtx({ shape: makeShape('shape-xyz') }));
    expect(decision.shapeId).toBe('shape-xyz');
  });

  test('is null for a tick trigger', () => {
    const decision = evaluateRules([], tickCtx());
    expect(decision.shapeId).toBeNull();
  });

  test('is null for an event trigger', () => {
    const decision = evaluateRules([], eventCtx());
    expect(decision.shapeId).toBeNull();
  });
});

describe('evaluateRules matches evaluateCompiled(compileRules(...))', () => {
  test('produces the same decision as compiling then evaluating directly', () => {
    const rule = literalRule('boom', 'triage');
    const ctx = lineCtx({ line: 'boom' });
    const viaHelper = evaluateRules([rule], ctx);
    const viaManual = evaluateCompiled(compileRules([rule]), ctx);
    expect(viaHelper).toEqual(viaManual);
  });
});
