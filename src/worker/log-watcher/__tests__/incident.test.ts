import { describe, expect, it } from 'bun:test';
import type { LogSignal } from '@/worker/log-watcher/types';
import { IncidentCoalescer, incidentFingerprint, incidentIdFor, scopeKeyFor } from '@/worker/log-watcher/incident';

let seq = 0;

function makeSignal(overrides: Partial<LogSignal> = {}): LogSignal {
  seq += 1;
  const at = overrides.at ?? seq;
  return {
    at,
    entityId: overrides.entityId ?? `host1/c${seq}`,
    host: overrides.host ?? 'host1',
    containerName: overrides.containerName ?? `c${seq}`,
    image: overrides.image ?? null,
    stackProject: overrides.stackProject ?? null,
    serviceKey: overrides.serviceKey ?? null,
    tier: overrides.tier ?? 1,
    lane: overrides.lane ?? 'triage',
    trigger: overrides.trigger ?? 'line',
    decidingRuleId: overrides.decidingRuleId ?? null,
    ruleIds: overrides.ruleIds ?? [],
    ruleNames: overrides.ruleNames ?? [],
    shapeId: overrides.shapeId ?? null,
    hardSignal: overrides.hardSignal ?? false,
    coldStart: overrides.coldStart ?? false,
    sinceImageChangeMs: overrides.sinceImageChangeMs ?? null,
    windowStart: overrides.windowStart ?? at - 60_000,
    windowEnd: overrides.windowEnd ?? at,
    metrics: overrides.metrics ?? {
      windowMs: 60_000,
      lineCount: 1,
      stderrCount: 0,
      stderrRatio: null,
      baselineExpected: null,
      baselineZ: null,
    },
    event: overrides.event ?? null,
    excerptLines: overrides.excerptLines ?? [],
  };
}

describe('IncidentCoalescer scope promotion', () => {
  it('merges six containers of one stack into a single stack-scope incident', () => {
    const coalescer = new IncidentCoalescer();
    let last;
    for (let i = 1; i <= 6; i += 1) {
      last = coalescer.admit(
        makeSignal({ entityId: `host1/c${i}`, host: 'host1', stackProject: 'proj', at: i * 100 }),
        i * 100,
      );
    }

    expect(last!.incident.scope).toBe('stack');
    expect(last!.incident.entityIds).toEqual(['host1/c1', 'host1/c2', 'host1/c3', 'host1/c4', 'host1/c5', 'host1/c6']);
    expect(last!.incident.signalCount).toBe(6);
    expect(last!.incident.mergedFrom).toHaveLength(2);
    expect(coalescer.open()).toHaveLength(1);
  });

  it('keeps two unrelated stacks on different hosts as separate incidents', () => {
    const coalescer = new IncidentCoalescer();
    coalescer.admit(makeSignal({ entityId: 'host1/a1', host: 'host1', stackProject: 'stackA', at: 100 }), 100);
    const resultA = coalescer.admit(makeSignal({ entityId: 'host1/a2', host: 'host1', stackProject: 'stackA', at: 200 }), 200);

    coalescer.admit(makeSignal({ entityId: 'host2/b1', host: 'host2', stackProject: 'stackB', at: 100 }), 100);
    const resultB = coalescer.admit(makeSignal({ entityId: 'host2/b2', host: 'host2', stackProject: 'stackB', at: 200 }), 200);

    expect(resultA.incident.id).not.toBe(resultB.incident.id);
    expect(resultA.incident.scope).toBe('stack');
    expect(resultB.incident.scope).toBe('stack');
    expect(resultA.incident.host).toBe('host1');
    expect(resultB.incident.host).toBe('host2');
    expect(coalescer.open()).toHaveLength(2);
  });

  it('promotes to host scope only when both entity and distinct-stack thresholds are crossed', () => {
    const coalescer = new IncidentCoalescer();
    coalescer.admit(makeSignal({ entityId: 'host1/x1', host: 'host1', stackProject: null, at: 100 }), 100);
    coalescer.admit(makeSignal({ entityId: 'host1/x2', host: 'host1', stackProject: null, at: 200 }), 200);
    const third = coalescer.admit(makeSignal({ entityId: 'host1/x3', host: 'host1', stackProject: 'projX', at: 300 }), 300);

    expect(third.promoted).toBe(true);
    expect(third.incident.scope).toBe('host');
    expect(third.incident.entityIds).toEqual(['host1/x1', 'host1/x2', 'host1/x3']);
    expect(third.incident.stackProject).toBeNull();
  });

  it('does not promote a same-stack group to host scope: only one distinct stack value present', () => {
    const coalescer = new IncidentCoalescer();
    coalescer.admit(makeSignal({ entityId: 'host1/y1', host: 'host1', stackProject: 'projY', at: 100 }), 100);
    coalescer.admit(makeSignal({ entityId: 'host1/y2', host: 'host1', stackProject: 'projY', at: 200 }), 200);
    const third = coalescer.admit(makeSignal({ entityId: 'host1/y3', host: 'host1', stackProject: 'projY', at: 300 }), 300);

    expect(third.incident.scope).toBe('stack');
  });

  it('files a dispatched sibling incident id into mergedFrom without absorbing it', () => {
    const coalescer = new IncidentCoalescer({ followupWindowMs: 10_000 });
    const first = coalescer.admit(makeSignal({ entityId: 'host1/d1', host: 'host1', stackProject: 'projD', at: 100 }), 100);
    coalescer.markDispatched(first.incident.id, 150);

    coalescer.admit(makeSignal({ entityId: 'host1/d2', host: 'host1', stackProject: 'projD', at: 200 }), 200);
    const third = coalescer.admit(makeSignal({ entityId: 'host1/d3', host: 'host1', stackProject: 'projD', at: 300 }), 300);

    expect(third.incident.scope).toBe('stack');
    expect(third.incident.entityIds).toEqual(['host1/d2', 'host1/d3']);
    expect(third.incident.mergedFrom).toContain(first.incident.id);

    const stillTracked = coalescer.get(first.incident.id);
    expect(stillTracked).not.toBeNull();
    expect(stillTracked!.state).toBe('dispatched');
  });
});

describe('IncidentCoalescer single-entity rule merging', () => {
  it('merges several rules firing on the same container into one incident', () => {
    const coalescer = new IncidentCoalescer();
    coalescer.admit(
      makeSignal({ entityId: 'host1/e1', decidingRuleId: 'rule-a', ruleIds: ['rule-a'], ruleNames: ['Rule A'], at: 100 }),
      100,
    );
    coalescer.admit(
      makeSignal({ entityId: 'host1/e1', decidingRuleId: 'rule-b', ruleIds: ['rule-b'], ruleNames: ['Rule B'], at: 200 }),
      200,
    );
    const third = coalescer.admit(
      makeSignal({ entityId: 'host1/e1', decidingRuleId: 'rule-c', ruleIds: ['rule-c'], ruleNames: ['Rule C'], at: 300 }),
      300,
    );

    expect(third.incident.scope).toBe('container');
    expect(third.incident.entityIds).toEqual(['host1/e1']);
    expect(third.incident.signalCount).toBe(3);
    const allRuleIds = new Set(third.incident.signals.flatMap((s) => s.ruleIds));
    expect(allRuleIds).toEqual(new Set(['rule-a', 'rule-b', 'rule-c']));
  });

  it('page lane wins severity over triage when merged onto the same incident', () => {
    const coalescer = new IncidentCoalescer();
    coalescer.admit(makeSignal({ entityId: 'host1/p1', lane: 'triage', at: 100 }), 100);
    const result = coalescer.admit(makeSignal({ entityId: 'host1/p1', lane: 'page', at: 200 }), 200);

    expect(result.incident.lane).toBe('page');
  });
});

describe('IncidentCoalescer page lane handling', () => {
  it('returns page signals immediately and still files them into the coalescing path', () => {
    const coalescer = new IncidentCoalescer();
    const signal = makeSignal({ entityId: 'host1/pg1', lane: 'page', at: 100 });
    const result = coalescer.admit(signal, 100);

    expect(result.immediatePages).toEqual([signal]);
    expect(result.incident.entityIds).toEqual(['host1/pg1']);
    expect(result.incident.signals).toContainEqual(signal);
  });

  it('does not return triage signals in immediatePages', () => {
    const coalescer = new IncidentCoalescer();
    const result = coalescer.admit(makeSignal({ entityId: 'host1/t1', lane: 'triage', at: 100 }), 100);
    expect(result.immediatePages).toEqual([]);
  });
});

describe('IncidentCoalescer occurrence and follow-up dispatch', () => {
  it('increments occurrence across repeated dispatches and requires a fingerprint change plus interval', () => {
    const coalescer = new IncidentCoalescer({ followupMinIntervalMs: 1_000, followupWindowMs: 10_000 });
    const opened = coalescer.admit(
      makeSignal({ entityId: 'host1/o1', decidingRuleId: 'r1', ruleIds: ['r1'], at: 0 }),
      0,
    );
    expect(opened.incident.occurrence).toBe(0);

    const debounceFn = () => 100;
    const dueAtOpen = coalescer.due(200, debounceFn);
    expect(dueAtOpen).toHaveLength(1);
    expect(dueAtOpen[0]!.reason).toBe('debounce');

    const dispatched = coalescer.markDispatched(opened.incident.id, 200);
    expect(dispatched!.occurrence).toBe(1);
    expect(dispatched!.state).toBe('dispatched');

    const repeatSameRule = coalescer.admit(
      makeSignal({ entityId: 'host1/o1', decidingRuleId: 'r1', ruleIds: ['r1'], at: 300 }),
      300,
    );
    expect(repeatSameRule.incident.id).toBe(opened.incident.id);

    const notDueYet = coalescer.due(500, debounceFn);
    expect(notDueYet).toHaveLength(0);

    const newRule = coalescer.admit(
      makeSignal({ entityId: 'host1/o1', decidingRuleId: 'r2', ruleIds: ['r2'], at: 600 }),
      600,
    );
    expect(newRule.incident.id).toBe(opened.incident.id);

    const notDueBeforeInterval = coalescer.due(900, debounceFn);
    expect(notDueBeforeInterval).toHaveLength(0);

    const dueForFollowup = coalescer.due(1_300, debounceFn);
    expect(dueForFollowup).toHaveLength(1);
    expect(dueForFollowup[0]!.reason).toBe('followup');

    const dispatchedAgain = coalescer.markDispatched(opened.incident.id, 1_300);
    expect(dispatchedAgain!.occurrence).toBe(2);
  });

  it('opens a fresh incident with a new id once the follow-up window has lapsed', () => {
    const coalescer = new IncidentCoalescer({ followupWindowMs: 500 });
    const first = coalescer.admit(makeSignal({ entityId: 'host1/f1', at: 0 }), 0);
    coalescer.markDispatched(first.incident.id, 100);

    const late = coalescer.admit(makeSignal({ entityId: 'host1/f1', at: 1_000 }), 1_000);
    expect(late.incident.id).not.toBe(first.incident.id);
    expect(late.incident.state).toBe('open');
  });

  it('markDispatched returns null for an unknown incident id', () => {
    const coalescer = new IncidentCoalescer();
    expect(coalescer.markDispatched('does-not-exist', 0)).toBeNull();
  });
});

describe('IncidentCoalescer windows and sweeping', () => {
  it('starts a new incident once the hard max-window cap is exceeded, even with continuous signals', () => {
    const coalescer = new IncidentCoalescer({ windowMs: 30_000, maxWindowMs: 100 });
    const first = coalescer.admit(makeSignal({ entityId: 'host1/w1', at: 0 }), 0);
    const second = coalescer.admit(makeSignal({ entityId: 'host1/w1', at: 50 }), 50);
    expect(second.incident.id).toBe(first.incident.id);

    const third = coalescer.admit(makeSignal({ entityId: 'host1/w1', at: 200 }), 200);
    expect(third.incident.id).not.toBe(first.incident.id);
    expect(coalescer.size()).toBe(2);
  });

  it('sweep closes an idle open incident past the sliding window and frees its entity', () => {
    const coalescer = new IncidentCoalescer({ windowMs: 1_000 });
    const opened = coalescer.admit(makeSignal({ entityId: 'host1/s1', at: 0 }), 0);

    const closed = coalescer.sweep(2_000);
    expect(closed.map((i) => i.id)).toEqual([opened.incident.id]);
    expect(coalescer.get(opened.incident.id)).toBeNull();

    const reopened = coalescer.admit(makeSignal({ entityId: 'host1/s1', at: 2_100 }), 2_100);
    expect(reopened.incident.id).not.toBe(opened.incident.id);
  });

  it('sweep closes a dispatched incident once its follow-up window elapses with no new signal', () => {
    const coalescer = new IncidentCoalescer({ followupWindowMs: 1_000 });
    const opened = coalescer.admit(makeSignal({ entityId: 'host1/s2', at: 0 }), 0);
    coalescer.markDispatched(opened.incident.id, 0);

    const closed = coalescer.sweep(5_000);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.state).toBe('closed');
    expect(coalescer.get(opened.incident.id)).toBeNull();
  });

  it('sweep leaves incidents untouched while they are within window', () => {
    const coalescer = new IncidentCoalescer({ windowMs: 10_000 });
    const opened = coalescer.admit(makeSignal({ entityId: 'host1/s3', at: 0 }), 0);
    const closed = coalescer.sweep(500);
    expect(closed).toHaveLength(0);
    expect(coalescer.get(opened.incident.id)).not.toBeNull();
  });
});

describe('IncidentCoalescer capacity enforcement', () => {
  it('force-closes the oldest open incident once max open incidents is exceeded', () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => {
      warnings.push(msg);
    };
    try {
      const coalescer = new IncidentCoalescer({ maxOpenIncidents: 2 });
      const first = coalescer.admit(makeSignal({ entityId: 'host1/m1', host: 'host1', at: 0 }), 0);
      coalescer.admit(makeSignal({ entityId: 'host2/m2', host: 'host2', at: 100 }), 100);
      coalescer.admit(makeSignal({ entityId: 'host3/m3', host: 'host3', at: 200 }), 200);

      expect(coalescer.open()).toHaveLength(2);
      expect(coalescer.get(first.incident.id)).toBeNull();
      expect(warnings).toHaveLength(1);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('IncidentCoalescer accessors', () => {
  it('get, open and size reflect current tracked incidents', () => {
    const coalescer = new IncidentCoalescer();
    expect(coalescer.get('nope')).toBeNull();
    expect(coalescer.open()).toEqual([]);
    expect(coalescer.size()).toBe(0);

    const result = coalescer.admit(makeSignal({ entityId: 'host1/acc1', at: 0 }), 0);
    expect(coalescer.get(result.incident.id)).toEqual(result.incident);
    expect(coalescer.open()).toHaveLength(1);
    expect(coalescer.size()).toBe(1);

    coalescer.markDispatched(result.incident.id, 0);
    expect(coalescer.open()).toHaveLength(0);
    expect(coalescer.size()).toBe(1);
  });
});

describe('incidentIdFor / incidentFingerprint / scopeKeyFor', () => {
  it('is deterministic for identical inputs and varies with scopeKey or openedAt', () => {
    const a = incidentIdFor('container', 'entity:host1/x', 1_000);
    const b = incidentIdFor('container', 'entity:host1/x', 1_000);
    const c = incidentIdFor('container', 'entity:host1/y', 1_000);
    const d = incidentIdFor('container', 'entity:host1/x', 2_000);

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a.startsWith('inc-e-')).toBe(true);
  });

  it('uses an injected hash function when provided', () => {
    const hash = (input: string) => `custom:${input}`;
    const id = incidentIdFor('stack', 'stack:host1/proj', 500, hash);
    expect(id).toBe(`inc-s-${`custom:stack:host1/proj\u001f500`.slice(0, 12)}`);
  });

  it('prefixes ids by scope', () => {
    expect(incidentIdFor('container', 'k', 1)).toMatch(/^inc-e-/);
    expect(incidentIdFor('stack', 'k', 1)).toMatch(/^inc-s-/);
    expect(incidentIdFor('host', 'k', 1)).toMatch(/^inc-h-/);
  });

  it('changes fingerprint when entities, rules, or lane change', () => {
    const coalescer = new IncidentCoalescer();
    const opened = coalescer.admit(
      makeSignal({ entityId: 'host1/fp1', ruleIds: ['r1'], lane: 'triage', at: 0 }),
      0,
    );
    const baseline = incidentFingerprint(opened.incident);

    const afterNewRule = coalescer.admit(
      makeSignal({ entityId: 'host1/fp1', ruleIds: ['r2'], lane: 'triage', at: 100 }),
      100,
    );
    expect(incidentFingerprint(afterNewRule.incident)).not.toBe(baseline);
  });

  it('formats scope keys for all three scopes', () => {
    const signal = makeSignal({ entityId: 'host1/sk1', host: 'host1', stackProject: 'proj', at: 0 });
    expect(scopeKeyFor('container', signal)).toBe('entity:host1/sk1');
    expect(scopeKeyFor('stack', signal)).toBe('stack:host1/proj');
    expect(scopeKeyFor('host', signal)).toBe('host:host1');
  });

  it('formats a stack scope key with an empty project segment when stackProject is null', () => {
    const signal = makeSignal({ entityId: 'host1/sk2', host: 'host1', stackProject: null, at: 0 });
    expect(scopeKeyFor('stack', signal)).toBe('stack:host1/');
  });
});

describe('Incident payload-readiness invariant (data owned by this module)', () => {
  it('never leaves undefined on a minimal, stack-less, event-less incident', () => {
    const coalescer = new IncidentCoalescer();
    const signal = makeSignal({
      entityId: 'host1/min1',
      host: 'host1',
      image: null,
      stackProject: null,
      serviceKey: null,
      shapeId: null,
      event: null,
      coldStart: true,
      sinceImageChangeMs: null,
      at: 0,
    });
    const result = coalescer.admit(signal, 0);
    const incident = result.incident;

    for (const [key, value] of Object.entries(incident)) {
      expect(value === undefined, `field ${key} must not be undefined`).toBe(false);
    }
    expect(incident.stackProject).toBeNull();
    expect(incident.dispatchedAt).toBeNull();
    expect(incident.dispatchedFingerprint).toBeNull();
    expect(incident.mergedFrom).toEqual([]);
    expect(incident.primaryEntityId).toBe('host1/min1');
    expect(incident.entityIds).toEqual(['host1/min1']);
  });
});
