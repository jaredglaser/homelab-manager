import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { Clock, ExcerptLine, Incident, LogSignal } from '@/worker/log-watcher/types';
import {
  buildHermesPayload,
  CapacityGate,
  EXCERPT_MAX_BYTES,
  HERMES_PAYLOAD_FIELDS,
  HermesDispatcher,
  PayloadTooLargeError,
  PAYLOAD_MAX_BYTES,
  renderExcerpt,
  signHermesRequest,
} from '@/worker/log-watcher/hermes-dispatcher';
import type {
  BudgetBucket,
  BudgetStore,
  DeliveryResult,
  HermesRuntimeConfig,
} from '@/worker/log-watcher/hermes-dispatcher';
import type { DerivedCapacity, HermesCeilings } from '@/worker/log-watcher/tier';

const BASE_AT = 1_700_000_000_000;

function makeSignal(overrides: Partial<LogSignal> = {}): LogSignal {
  return {
    at: BASE_AT,
    entityId: 'host1/c1',
    host: 'host1',
    containerName: 'jellyfin',
    image: 'jellyfin/jellyfin:latest',
    stackProject: 'media',
    serviceKey: 'jellyfin',
    tier: 1,
    lane: 'triage',
    trigger: 'tick',
    decidingRuleId: 'seed:rule-1',
    ruleIds: ['seed:rule-1'],
    ruleNames: ['Rule One'],
    shapeId: 'shape-1',
    hardSignal: false,
    coldStart: false,
    sinceImageChangeMs: null,
    windowStart: BASE_AT - 60_000,
    windowEnd: BASE_AT,
    metrics: {
      windowMs: 60_000,
      lineCount: 12,
      stderrCount: 4,
      stderrRatio: 4 / 12,
      baselineExpected: 2,
      baselineZ: 5,
    },
    event: null,
    excerptLines: [{ at: BASE_AT - 1_000, stream: 'stderr', text: 'boom' }],
    ...overrides,
  };
}

function makeIncident(overrides: Partial<Incident> = {}, signalOverrides: Partial<LogSignal> = {}): Incident {
  const signal = makeSignal(signalOverrides);
  return {
    id: 'inc-e-abc123',
    scope: 'container',
    scopeKey: `entity:${signal.entityId}`,
    state: 'open',
    openedAt: BASE_AT - 20_000,
    lastSignalAt: BASE_AT,
    dispatchedAt: null,
    occurrence: 0,
    tier: signal.tier,
    lane: signal.lane as 'page' | 'triage',
    host: signal.host,
    stackProject: signal.stackProject,
    primaryEntityId: signal.entityId,
    entityIds: [signal.entityId],
    signalCount: 1,
    signals: [signal],
    mergedFrom: [],
    dispatchedFingerprint: null,
    ...overrides,
  };
}

function minimalSignal(): LogSignal {
  return makeSignal({
    image: null,
    stackProject: null,
    serviceKey: null,
    shapeId: null,
    coldStart: true,
    sinceImageChangeMs: null,
    event: null,
    metrics: {
      windowMs: 60_000,
      lineCount: 0,
      stderrCount: 0,
      stderrRatio: null,
      baselineExpected: null,
      baselineZ: null,
    },
    excerptLines: [],
    ruleIds: [],
    ruleNames: [],
  });
}

function minimalIncident(): Incident {
  const signal = minimalSignal();
  return makeIncident(
    {
      stackProject: null,
      mergedFrom: [],
    },
    signal,
  );
}

describe('signHermesRequest', () => {
  it('signs the exact byte string "<unix-seconds>.<body>" with hex HMAC-SHA256, independently verified', () => {
    const body = JSON.stringify({ hello: 'world' });
    const secret = 'super-secret';
    const timestampSeconds = 1_700_000_000;
    const requestId = 'inc-e-abc-1';

    const headers = signHermesRequest(body, secret, timestampSeconds, requestId);

    const expectedSignature = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');

    expect(headers['X-Webhook-Signature-V2']).toBe(expectedSignature);
    expect(headers['X-Webhook-Timestamp']).toBe(String(timestampSeconds));
    expect(headers['X-Request-ID']).toBe(requestId);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('produces a different signature for a different body (not signing an empty/constant string)', () => {
    const secret = 'k';
    const a = signHermesRequest('{"a":1}', secret, 1_700_000_000, 'r-1');
    const b = signHermesRequest('{"a":2}', secret, 1_700_000_000, 'r-1');
    expect(a['X-Webhook-Signature-V2']).not.toBe(b['X-Webhook-Signature-V2']);
  });
});

describe('buildHermesPayload', () => {
  it('produces exactly HERMES_PAYLOAD_FIELDS as keys for a minimal signal, with no null/undefined values', () => {
    const incident = minimalIncident();
    const payload = buildHermesPayload({
      incident,
      occurrence: 1,
      lane: 'triage',
      route: 'homelab-log-triage-t1',
      at: BASE_AT,
    });

    expect(Object.keys(payload).sort()).toEqual([...HERMES_PAYLOAD_FIELDS]);
    for (const [key, value] of Object.entries(payload)) {
      expect(value).not.toBeNull();
      expect(value).not.toBeUndefined();
      if (key !== 'occurrence' && key !== 'tier' && key !== 'entityCount' && key !== 'signalCount' && key !== 'lineCount' && key !== 'stderrCount') {
        expect(typeof value).toBe('string');
      }
    }
    expect(payload.image).toBe('');
    expect(payload.stack).toBe('');
    expect(payload.service).toBe('');
    expect(payload.shapeIds).toBe('');
    expect(payload.eventType).toBe('');
    expect(payload.exitCode).toBe('');
    expect(payload.oomKilled).toBe('');
    expect(payload.healthy).toBe('');
    expect(payload.restartsInWindow).toBe('');
    expect(payload.mergedFrom).toBe('');
    expect(payload.sinceImageChangeMs).toBe('');
    expect(payload.stderrRatio).toBe('');
    expect(payload.baselineExpected).toBe('');
    expect(payload.baselineZ).toBe('');
    expect(payload.digest).toBe('');
    expect(payload.dashboardUrl).toBe('');
    expect(typeof payload.excerpt).toBe('string');
  });

  it('never renders digest for tier 1/2 even when a digest string is supplied', () => {
    const incident = makeIncident({ tier: 1 });
    const payload = buildHermesPayload({
      incident,
      occurrence: 1,
      lane: 'triage',
      route: 'homelab-log-triage-t1',
      at: BASE_AT,
      digest: 'some rendered digest text',
    });
    expect(payload.digest).toBe('');
  });

  it('renders digest for tier 0 when supplied', () => {
    const incident = makeIncident({ tier: 0, lane: 'triage' }, { tier: 0, lane: 'triage' });
    const payload = buildHermesPayload({
      incident,
      occurrence: 1,
      lane: 'triage',
      route: 'homelab-log-triage-t0',
      at: BASE_AT,
      digest: 'digest text',
    });
    expect(payload.digest).toBe('digest text');
  });

  it('ships booleans as yes/no strings, never true/false', () => {
    const signal = makeSignal({
      coldStart: true,
      event: {
        eventType: 'die',
        state: 'exited',
        exitCode: 0,
        oomKilled: true,
        healthStatus: 'healthy',
        restartsInWindow: 2,
      },
    });
    const incident = makeIncident({}, signal);
    const payload = buildHermesPayload({ incident, occurrence: 1, lane: 'triage', route: 'r', at: BASE_AT });
    expect(payload.coldStart).toBe('yes');
    expect(payload.oomKilled).toBe('yes');
    expect(payload.healthy).toBe('yes');
    expect(payload.exitCode).toBe('0');
    expect(payload.eventType).toBe('die');
    expect(payload.restartsInWindow).toBe('2');
  });

  it('distinguishes exitCode 0 from absent (empty string)', () => {
    const withZero = makeIncident(
      {},
      {
        event: { eventType: 'die', state: 'exited', exitCode: 0, oomKilled: false, healthStatus: null, restartsInWindow: 0 },
      },
    );
    const withoutEvent = makeIncident({}, { event: null });
    const payloadZero = buildHermesPayload({ incident: withZero, occurrence: 1, lane: 'triage', route: 'r', at: BASE_AT });
    const payloadAbsent = buildHermesPayload({ incident: withoutEvent, occurrence: 1, lane: 'triage', route: 'r', at: BASE_AT });
    expect(payloadZero.exitCode).toBe('0');
    expect(payloadAbsent.exitCode).toBe('');
  });

  it('caps entities/containers at 20 with a "+N more" suffix', () => {
    const entityIds = Array.from({ length: 25 }, (_, i) => `host1/c${i}`);
    const signals: LogSignal[] = entityIds.map((id, i) => makeSignal({ entityId: id, containerName: `c${i}` }));
    const incident = makeIncident({
      entityIds,
      signals,
      signalCount: signals.length,
      primaryEntityId: entityIds[0],
    });
    const payload = buildHermesPayload({ incident, occurrence: 1, lane: 'triage', route: 'r', at: BASE_AT });
    expect(payload.entities).toContain('+5 more');
    expect(payload.containers).toContain('+5 more');
  });

  it('joins ruleIds with the deciding rule first and ruleNames index-aligned', () => {
    const signal = makeSignal({
      decidingRuleId: 'seed:panic',
      ruleIds: ['seed:panic', 'seed:other'],
      ruleNames: ['Panic', 'Other'],
    });
    const incident = makeIncident({ primaryEntityId: signal.entityId }, signal);
    const payload = buildHermesPayload({ incident, occurrence: 1, lane: 'page', route: 'r', at: BASE_AT });
    expect(payload.ruleIds).toBe('seed:panic,seed:other');
    expect(payload.ruleNames).toBe('Panic,Other');
  });

  it('shrinks the payload in order (digest, then excerpt, then list truncation) before giving up', () => {
    const hugeText = 'x'.repeat(3_000);
    const manyLines: ExcerptLine[] = Array.from({ length: 50 }, (_, i) => ({
      at: BASE_AT - i * 1_000,
      stream: 'stdout' as const,
      text: hugeText,
    }));
    const signal = makeSignal({ excerptLines: manyLines });
    const incident = makeIncident({ tier: 0 }, { ...signal, tier: 0 });
    const withoutDigest = buildHermesPayload({ incident, occurrence: 1, lane: 'triage', route: 'r', at: BASE_AT });
    expect(Buffer.byteLength(String(withoutDigest.excerpt), 'utf8')).toBeLessThanOrEqual(EXCERPT_MAX_BYTES);

    const withDigest = buildHermesPayload({
      incident,
      occurrence: 1,
      lane: 'triage',
      route: 'r',
      at: BASE_AT,
      digest: 'x'.repeat(2_000),
    });
    expect(Buffer.byteLength(JSON.stringify(withDigest), 'utf8')).toBeLessThanOrEqual(PAYLOAD_MAX_BYTES);
  });

  it('throws PayloadTooLargeError when even the fully shrunk payload exceeds the cap', () => {
    const hugeRuleId = 'r'.repeat(30_000);
    const ruleIds = Array.from({ length: 20 }, (_, i) => `${hugeRuleId}-${i}`);
    const ruleNames = ruleIds.map((id) => id);
    const signal = makeSignal({ ruleIds, ruleNames, decidingRuleId: ruleIds[0] });
    const incident = makeIncident({}, signal);
    expect(() => buildHermesPayload({ incident, occurrence: 1, lane: 'triage', route: 'r', at: BASE_AT })).toThrow(
      PayloadTooLargeError,
    );
  });

  it('caps the title at 200 characters', () => {
    const signal = makeSignal({
      containerName: 'c'.repeat(300),
      ruleNames: ['r'.repeat(300)],
      ruleIds: ['rule-x'],
    });
    const incident = makeIncident({}, signal);
    const payload = buildHermesPayload({ incident, occurrence: 1, lane: 'triage', route: 'r', at: BASE_AT });
    expect((payload.title as string).length).toBeLessThanOrEqual(200);
  });

  it('derives severity as page for the page lane, warn for tier <=1 triage, info for tier 2 triage', () => {
    const t0 = buildHermesPayload({
      incident: makeIncident({ tier: 0, lane: 'page' }, { tier: 0, lane: 'page' }),
      occurrence: 1,
      lane: 'page',
      route: 'r',
      at: BASE_AT,
    });
    const t1 = buildHermesPayload({
      incident: makeIncident({ tier: 1 }, { tier: 1 }),
      occurrence: 1,
      lane: 'triage',
      route: 'r',
      at: BASE_AT,
    });
    const t2 = buildHermesPayload({
      incident: makeIncident({ tier: 2 }, { tier: 2 }),
      occurrence: 1,
      lane: 'triage',
      route: 'r',
      at: BASE_AT,
    });
    expect(t0.severity).toBe('page');
    expect(t1.severity).toBe('warn');
    expect(t2.severity).toBe('info');
  });

  it('builds the dashboard URL only when a base URL is configured', () => {
    const incident = makeIncident();
    const withBase = buildHermesPayload({
      incident,
      occurrence: 1,
      lane: 'triage',
      route: 'r',
      at: BASE_AT,
      dashboardBaseUrl: 'https://dash.example.com/',
    });
    const withoutBase = buildHermesPayload({ incident, occurrence: 1, lane: 'triage', route: 'r', at: BASE_AT });
    expect(withBase.dashboardUrl).toBe(`https://dash.example.com/incidents/${incident.id}`);
    expect(withoutBase.dashboardUrl).toBe('');
  });
});

describe('renderExcerpt', () => {
  it('returns an empty string for no lines', () => {
    expect(renderExcerpt([])).toBe('');
  });

  it('renders every line when under the byte cap', () => {
    const lines: ExcerptLine[] = [
      { at: BASE_AT - 2_000, stream: 'stdout', text: 'first' },
      { at: BASE_AT - 1_000, stream: 'stderr', text: 'second' },
    ];
    const rendered = renderExcerpt(lines, 4096);
    expect(rendered).toContain('first');
    expect(rendered).toContain('second');
    expect(rendered.indexOf('first')).toBeLessThan(rendered.indexOf('second'));
  });

  it('keeps the newest lines and drops the oldest when over budget, staying within the byte cap', () => {
    const lines: ExcerptLine[] = Array.from({ length: 20 }, (_, i) => ({
      at: BASE_AT + i * 1_000,
      stream: 'stdout' as const,
      text: `line-${i}-${'y'.repeat(50)}`,
    }));
    const rendered = renderExcerpt(lines, 300);
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(300);
    expect(rendered).toContain('line-19');
    expect(rendered).toContain('truncated');
  });

  it('falls back to a UTF-8-safe truncated placeholder when not even one line fits', () => {
    const lines: ExcerptLine[] = [{ at: BASE_AT, stream: 'stdout', text: 'x'.repeat(1_000) }];
    const rendered = renderExcerpt(lines, 20);
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(20);
    expect(rendered).toContain('truncated');
  });
});

describe('CapacityGate', () => {
  function capacity(overrides: Partial<DerivedCapacity> = {}): DerivedCapacity {
    return {
      runningContainers: 100,
      maxInFlight: 4,
      t0Reserved: 2,
      sharedPool: 2,
      t2Ceiling: 1,
      dailyRuns: 100,
      dailyPages: 100,
      dailyByBucket: { t0: 40, t1: 40, t2: 20 },
      ...overrides,
    };
  }

  it('refuses tier 1 once the shared pool is full while still granting tier 0', () => {
    const gate = new CapacityGate(capacity());
    expect(gate.tryAcquire(1)).toBe(true);
    expect(gate.tryAcquire(1)).toBe(true);
    expect(gate.tryAcquire(1)).toBe(false);
    expect(gate.tryAcquire(0)).toBe(true);
    expect(gate.tryAcquire(0)).toBe(true);
    expect(gate.inFlight()).toEqual({ t0: 2, t1: 2, t2: 0 });
  });

  it('refuses tier 2 past its own ceiling even when the shared pool has room', () => {
    const gate = new CapacityGate(capacity({ maxInFlight: 6, t0Reserved: 2, sharedPool: 4, t2Ceiling: 1 }));
    expect(gate.tryAcquire(2)).toBe(true);
    expect(gate.tryAcquire(2)).toBe(false);
    expect(gate.tryAcquire(1)).toBe(true);
  });

  it('refuses every tier once the global ceiling is reached', () => {
    const gate = new CapacityGate(capacity({ maxInFlight: 1, t0Reserved: 1, sharedPool: 1, t2Ceiling: 1 }));
    expect(gate.tryAcquire(0)).toBe(true);
    expect(gate.tryAcquire(0)).toBe(false);
    expect(gate.tryAcquire(1)).toBe(false);
  });

  it('release frees a slot for the next acquire', () => {
    const gate = new CapacityGate(capacity({ maxInFlight: 1, t0Reserved: 1, sharedPool: 1, t2Ceiling: 1 }));
    expect(gate.tryAcquire(0)).toBe(true);
    expect(gate.tryAcquire(0)).toBe(false);
    gate.release(0);
    expect(gate.tryAcquire(0)).toBe(true);
  });

  it('update() applies a new capacity to subsequent acquires', () => {
    const gate = new CapacityGate(capacity({ maxInFlight: 1, t0Reserved: 1, sharedPool: 1, t2Ceiling: 1 }));
    expect(gate.tryAcquire(1)).toBe(true);
    expect(gate.tryAcquire(1)).toBe(false);
    gate.update(capacity({ maxInFlight: 3, t0Reserved: 1, sharedPool: 2, t2Ceiling: 1 }));
    expect(gate.tryAcquire(1)).toBe(true);
  });
});

function fakeClock(startMs: number): Clock & { set(ms: number): void; advance(ms: number): void } {
  let current = startMs;
  return {
    now: () => current,
    set(ms: number) {
      current = ms;
    },
    advance(ms: number) {
      current += ms;
    },
  };
}

function makeBudgetStore(initial: Partial<Record<BudgetBucket, number>> = {}): BudgetStore & {
  state: Record<BudgetBucket, number>;
  loadCalls: string[];
} {
  const state: Record<BudgetBucket, number> = { t0: 0, t1: 0, t2: 0, page: 0, ...initial };
  const loadCalls: string[] = [];
  return {
    state,
    loadCalls,
    async load(day: string) {
      loadCalls.push(day);
      return { ...state };
    },
    async increment(_day: string, bucket: BudgetBucket, by: number) {
      state[bucket] += by;
    },
  };
}

function makeConfig(overrides: Partial<HermesRuntimeConfig> = {}): HermesRuntimeConfig {
  return {
    enabled: true,
    gatewayUrl: 'https://hermes.example.com',
    secret: 'test-secret',
    dashboardBaseUrl: '',
    ...overrides,
  };
}

const CEILINGS: HermesCeilings = { maxInFlight: 8, maxDailyRuns: 300, maxDailyPages: 200 };

function makeDispatcher(opts: {
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
  config?: HermesRuntimeConfig;
  budgetStore?: BudgetStore;
  clock?: Clock;
  digestProvider?: (entityId: string, now: number) => Promise<string>;
}) {
  const abortController = new AbortController();
  const clock = opts.clock ?? fakeClock(BASE_AT);
  const config = opts.config ?? makeConfig();
  const budgetStore = opts.budgetStore ?? makeBudgetStore();
  const dispatcher = new HermesDispatcher({
    clock,
    fetchFn: opts.fetchFn,
    signal: abortController.signal,
    configProvider: async () => config,
    budgetStore,
    ceilingsProvider: () => CEILINGS,
    digestProvider: opts.digestProvider,
  });
  return { dispatcher, abortController, clock, config, budgetStore };
}

function entryFor(incident: Incident, occurrence = 1): {
  incident: Incident;
  lane: 'page' | 'triage';
  tier: 0 | 1 | 2;
  occurrence: number;
  route: string;
} {
  return {
    incident,
    lane: incident.lane,
    tier: incident.tier,
    occurrence,
    route: incident.lane === 'page' ? 'homelab-page-t0' : `homelab-log-triage-t${incident.tier}`,
  };
}

async function deliver(dispatcher: HermesDispatcher, entry: ReturnType<typeof entryFor>): Promise<DeliveryResult> {
  return (dispatcher as unknown as { deliverWithRetry(e: unknown): Promise<DeliveryResult> }).deliverWithRetry(entry);
}

describe('HermesDispatcher delivery outcomes', () => {
  let originalSetTimeout: typeof setTimeout;

  beforeEach(() => {
    originalSetTimeout = globalThis.setTimeout;
    spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
  });

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout;
  });

  it('treats 202 as accepted with no retry', async () => {
    let calls = 0;
    const { dispatcher } = makeDispatcher({
      fetchFn: async () => {
        calls += 1;
        return new Response(null, { status: 202 });
      },
    });
    const result = await deliver(dispatcher, entryFor(makeIncident()));
    expect(result.outcome).toBe('accepted');
    expect(result.status).toBe(202);
    expect(result.attempts).toBe(1);
    expect(calls).toBe(1);
  });

  it('treats a 200 body of {status:"duplicate"} as success-but-deduplicated, not an error', async () => {
    let calls = 0;
    const { dispatcher } = makeDispatcher({
      fetchFn: async () => {
        calls += 1;
        return new Response(JSON.stringify({ status: 'duplicate' }), { status: 200 });
      },
    });
    const result = await deliver(dispatcher, entryFor(makeIncident()));
    expect(result.outcome).toBe('duplicate');
    expect(result.attempts).toBe(1);
    expect(calls).toBe(1);
  });

  it('treats a plain 200 (no duplicate marker) as accepted', async () => {
    const { dispatcher } = makeDispatcher({
      fetchFn: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });
    const result = await deliver(dispatcher, entryFor(makeIncident()));
    expect(result.outcome).toBe('accepted');
  });

  it('retries a 429 up to 2 additional times honouring Retry-After, then drops without further queueing', async () => {
    let calls = 0;
    const { dispatcher } = makeDispatcher({
      fetchFn: async () => {
        calls += 1;
        return new Response('slow down', { status: 429, headers: { 'retry-after': '1' } });
      },
    });
    const result = await deliver(dispatcher, entryFor(makeIncident()));
    expect(result.outcome).toBe('rate-limited');
    expect(calls).toBe(3);
    expect(result.attempts).toBe(3);
  });

  it('retries a 503 (5xx transport) and eventually succeeds if a later attempt returns 202', async () => {
    let calls = 0;
    const { dispatcher } = makeDispatcher({
      fetchFn: async () => {
        calls += 1;
        if (calls < 2) return new Response('boom', { status: 503 });
        return new Response(null, { status: 202 });
      },
    });
    const result = await deliver(dispatcher, entryFor(makeIncident()));
    expect(result.outcome).toBe('accepted');
    expect(calls).toBe(2);
    expect(result.attempts).toBe(2);
  });

  it('exhausts retries on persistent 5xx and reports transport', async () => {
    let calls = 0;
    const { dispatcher } = makeDispatcher({
      fetchFn: async () => {
        calls += 1;
        return new Response('boom', { status: 500 });
      },
    });
    const result = await deliver(dispatcher, entryFor(makeIncident()));
    expect(result.outcome).toBe('transport');
    expect(calls).toBe(3);
  });

  it('does not retry a 400/401/403/413/422 rejection', async () => {
    let calls = 0;
    const { dispatcher } = makeDispatcher({
      fetchFn: async () => {
        calls += 1;
        return new Response('bad request', { status: 400 });
      },
    });
    const result = await deliver(dispatcher, entryFor(makeIncident()));
    expect(result.outcome).toBe('rejected');
    expect(calls).toBe(1);
    expect(result.attempts).toBe(1);
  });

  it('logs the body byte length on a 413 rejection', async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.join(' '));
    };
    try {
      const { dispatcher } = makeDispatcher({
        fetchFn: async () => new Response('too big', { status: 413 }),
      });
      await deliver(dispatcher, entryFor(makeIncident()));
    } finally {
      console.error = originalError;
    }
    expect(errors.some((line) => line.includes('bodyBytes='))).toBe(true);
  });

  it('re-signs with a fresh timestamp on every retry attempt', async () => {
    const seenTimestamps: string[] = [];
    let calls = 0;
    const { dispatcher, clock } = makeDispatcher({
      fetchFn: async (_url, init) => {
        calls += 1;
        const headers = init?.headers as Record<string, string>;
        seenTimestamps.push(headers['X-Webhook-Timestamp']);
        (clock as ReturnType<typeof fakeClock>).advance(1_000);
        if (calls < 2) return new Response('boom', { status: 500 });
        return new Response(null, { status: 202 });
      },
    });
    await deliver(dispatcher, entryFor(makeIncident()));
    expect(calls).toBe(2);
    expect(new Set(seenTimestamps).size).toBe(2);
  });

  it('a gateway that always fails opens the circuit after 5 consecutive transport failures and drops the next delivery without calling fetch', async () => {
    let calls = 0;
    const { dispatcher } = makeDispatcher({
      fetchFn: async () => {
        calls += 1;
        throw new Error('ECONNREFUSED');
      },
    });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(' '));
    };

    try {
      const first = await deliver(dispatcher, entryFor(makeIncident({ id: 'inc-1' })));
      expect(first.outcome).toBe('transport');
      const second = await deliver(dispatcher, entryFor(makeIncident({ id: 'inc-2' })));
      expect(second.outcome).toBe('transport');
      expect(calls).toBe(6);

      const third = await deliver(dispatcher, entryFor(makeIncident({ id: 'inc-3' })));
      expect(third.outcome).toBe('circuit-open');
      expect(third.status).toBeNull();
      expect(calls).toBe(6);
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings.filter((w) => w.includes('circuit open')).length).toBe(1);
  });

  it('does not open the circuit from 429 rate-limit responses alone', async () => {
    let calls = 0;
    const { dispatcher } = makeDispatcher({
      fetchFn: async () => {
        calls += 1;
        return new Response('slow down', { status: 429 });
      },
    });

    await deliver(dispatcher, entryFor(makeIncident({ id: 'inc-1' })));
    await deliver(dispatcher, entryFor(makeIncident({ id: 'inc-2' })));
    expect(calls).toBe(6);

    const third = await deliver(dispatcher, entryFor(makeIncident({ id: 'inc-3' })));
    expect(third.outcome).toBe('rate-limited');
    expect(calls).toBe(9);
  });

  it('closes the circuit after CIRCUIT_OPEN_MS elapses and resumes calling fetch', async () => {
    let calls = 0;
    let fail = true;
    const clock = fakeClock(BASE_AT);
    const { dispatcher } = makeDispatcher({
      clock,
      fetchFn: async () => {
        calls += 1;
        if (fail) throw new Error('down');
        return new Response(null, { status: 202 });
      },
    });

    await deliver(dispatcher, entryFor(makeIncident({ id: 'inc-1' })));
    await deliver(dispatcher, entryFor(makeIncident({ id: 'inc-2' })));
    expect(calls).toBe(6);

    const blocked = await deliver(dispatcher, entryFor(makeIncident({ id: 'inc-3' })));
    expect(blocked.outcome).toBe('circuit-open');
    expect(calls).toBe(6);

    fail = false;
    clock.advance(61_000);
    const recovered = await deliver(dispatcher, entryFor(makeIncident({ id: 'inc-4' })));
    expect(recovered.outcome).toBe('accepted');
    expect(calls).toBe(7);
  });

  it('does not hang and does not call fetch when Hermes is disabled', async () => {
    let calls = 0;
    const { dispatcher } = makeDispatcher({
      config: makeConfig({ enabled: false }),
      fetchFn: async () => {
        calls += 1;
        return new Response(null, { status: 202 });
      },
    });
    const result = await deliver(dispatcher, entryFor(makeIncident()));
    expect(result.outcome).toBe('disabled');
    expect(calls).toBe(0);
  });

  it('does not call fetch when the gateway URL is empty', async () => {
    let calls = 0;
    const { dispatcher } = makeDispatcher({
      config: makeConfig({ gatewayUrl: '' }),
      fetchFn: async () => {
        calls += 1;
        return new Response(null, { status: 202 });
      },
    });
    const result = await deliver(dispatcher, entryFor(makeIncident()));
    expect(result.outcome).toBe('disabled');
    expect(calls).toBe(0);
  });

  it('breaks out of the retry loop once MAX_DELIVERY_MS has elapsed rather than retrying forever', async () => {
    let calls = 0;
    const clock = fakeClock(BASE_AT);
    const { dispatcher } = makeDispatcher({
      clock,
      fetchFn: async () => {
        calls += 1;
        clock.advance(20_000);
        return new Response('boom', { status: 500 });
      },
    });
    const result = await deliver(dispatcher, entryFor(makeIncident()));
    expect(result.outcome).toBe('transport');
    expect(calls).toBeLessThan(3);
  });

  it('drops with an error and does not throw when buildHermesPayload rejects an oversized incident', async () => {
    let calls = 0;
    const hugeRuleId = 'r'.repeat(30_000);
    const ruleIds = Array.from({ length: 20 }, (_, i) => `${hugeRuleId}-${i}`);
    const signal = makeSignal({ ruleIds, ruleNames: ruleIds, decidingRuleId: ruleIds[0] });
    const incident = makeIncident({}, signal);
    const { dispatcher } = makeDispatcher({
      fetchFn: async () => {
        calls += 1;
        return new Response(null, { status: 202 });
      },
    });
    const result = await deliver(dispatcher, entryFor(incident));
    expect(result.outcome).toBe('rejected');
    expect(calls).toBe(0);
  });

  it('includes a tier-0 digest from the digest provider in the delivered body', async () => {
    let capturedBody = '';
    const { dispatcher } = makeDispatcher({
      digestProvider: async () => 'recent shapes: 12x OOM',
      fetchFn: async (_url, init) => {
        capturedBody = String(init?.body ?? '');
        return new Response(null, { status: 202 });
      },
    });
    const incident = makeIncident({ tier: 0, lane: 'page' }, { tier: 0, lane: 'page' });
    await deliver(dispatcher, entryFor(incident));
    expect(capturedBody).toContain('recent shapes: 12x OOM');
  });

  it('falls back to an empty digest when the digest provider throws', async () => {
    let capturedBody = '';
    const { dispatcher } = makeDispatcher({
      digestProvider: async () => {
        throw new Error('digest boom');
      },
      fetchFn: async (_url, init) => {
        capturedBody = String(init?.body ?? '');
        return new Response(null, { status: 202 });
      },
    });
    const incident = makeIncident({ tier: 0, lane: 'page' }, { tier: 0, lane: 'page' });
    const result = await deliver(dispatcher, entryFor(incident));
    expect(result.outcome).toBe('accepted');
    expect(capturedBody).toBeTruthy();
  });
});

describe('HermesDispatcher cooldown and budget', () => {
  it('admits a due incident only if at least one of its entities is out of cooldown', () => {
    const { dispatcher } = makeDispatcher({});
    const internal = dispatcher as unknown as {
      checkCooldownAndBudget(entry: ReturnType<typeof entryFor>, now: number): boolean;
      capacity: unknown;
    };
    (dispatcher as unknown as { capacityState: DerivedCapacity }).capacityState = {
      runningContainers: 100,
      maxInFlight: 4,
      t0Reserved: 2,
      sharedPool: 2,
      t2Ceiling: 1,
      dailyRuns: 100,
      dailyPages: 100,
      dailyByBucket: { t0: 40, t1: 40, t2: 20 },
    };

    const soleIncident = makeIncident({ entityIds: ['host1/c1'], primaryEntityId: 'host1/c1', tier: 1 }, { tier: 1 });
    const firstEntry = entryFor(soleIncident);
    expect(internal.checkCooldownAndBudget(firstEntry, BASE_AT)).toBe(true);

    const repeatIncident = makeIncident({ entityIds: ['host1/c1'], primaryEntityId: 'host1/c1', tier: 1 }, { tier: 1 });
    const repeatEntry = entryFor(repeatIncident);
    expect(internal.checkCooldownAndBudget(repeatEntry, BASE_AT + 1_000)).toBe(false);

    const multiEntityIncident = makeIncident(
      { entityIds: ['host1/c1', 'host1/c2'], primaryEntityId: 'host1/c1', tier: 1 },
      { tier: 1 },
    );
    const multiEntry = entryFor(multiEntityIncident);
    expect(internal.checkCooldownAndBudget(multiEntry, BASE_AT + 2_000)).toBe(true);

    expect(internal.checkCooldownAndBudget(firstEntry, BASE_AT + 700_000)).toBe(true);
  });

  it('drops a due incident once the tier bucket budget is exhausted for the day, warning once then info', () => {
    const budgetStore = makeBudgetStore({ t1: 40 });
    const { dispatcher } = makeDispatcher({ budgetStore });
    (dispatcher as unknown as { capacityState: DerivedCapacity }).capacityState = {
      runningContainers: 100,
      maxInFlight: 4,
      t0Reserved: 2,
      sharedPool: 2,
      t2Ceiling: 1,
      dailyRuns: 100,
      dailyPages: 100,
      dailyByBucket: { t0: 40, t1: 40, t2: 20 },
    };
    (dispatcher as unknown as { spentToday: Record<BudgetBucket, number> }).spentToday = {
      t0: 0,
      t1: 40,
      t2: 0,
      page: 0,
    };

    const internal = dispatcher as unknown as {
      checkCooldownAndBudget(entry: ReturnType<typeof entryFor>, now: number): boolean;
    };

    const warnings: string[] = [];
    const infos: string[] = [];
    const originalWarn = console.warn;
    const originalInfo = console.info;
    console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
    console.info = (...args: unknown[]) => infos.push(args.join(' '));

    try {
      const incidentA = makeIncident({ entityIds: ['host1/cA'], primaryEntityId: 'host1/cA', tier: 1 }, { tier: 1 });
      const incidentB = makeIncident({ entityIds: ['host1/cB'], primaryEntityId: 'host1/cB', tier: 1 }, { tier: 1 });
      expect(internal.checkCooldownAndBudget(entryFor(incidentA), BASE_AT)).toBe(false);
      expect(internal.checkCooldownAndBudget(entryFor(incidentB), BASE_AT + 1_000)).toBe(false);
    } finally {
      console.warn = originalWarn;
      console.info = originalInfo;
    }

    expect(warnings.filter((w) => w.includes('budget exhausted')).length).toBe(1);
    expect(infos.filter((w) => w.includes('budget exhausted')).length).toBe(1);
  });

  it('lets a tier-0 page through its own page bucket even when the t0 triage bucket is exhausted', () => {
    const { dispatcher } = makeDispatcher({});
    (dispatcher as unknown as { capacityState: DerivedCapacity }).capacityState = {
      runningContainers: 100,
      maxInFlight: 4,
      t0Reserved: 2,
      sharedPool: 2,
      t2Ceiling: 1,
      dailyRuns: 100,
      dailyPages: 100,
      dailyByBucket: { t0: 5, t1: 40, t2: 20 },
    };
    (dispatcher as unknown as { spentToday: Record<BudgetBucket, number> }).spentToday = {
      t0: 5,
      t1: 0,
      t2: 0,
      page: 0,
    };
    const internal = dispatcher as unknown as {
      checkCooldownAndBudget(entry: ReturnType<typeof entryFor>, now: number): boolean;
    };

    const pageIncident = makeIncident({ lane: 'page', tier: 0, entityIds: ['host1/cP'], primaryEntityId: 'host1/cP' }, { tier: 0, lane: 'page' });
    expect(internal.checkCooldownAndBudget(entryFor(pageIncident), BASE_AT)).toBe(true);

    const triageIncident = makeIncident({ lane: 'triage', tier: 0, entityIds: ['host1/cT'], primaryEntityId: 'host1/cT' }, { tier: 0 });
    expect(internal.checkCooldownAndBudget(entryFor(triageIncident), BASE_AT)).toBe(false);
  });

  it('reserves budget on a passing check and releases it again on a non-accepted delivery outcome', async () => {
    let calls = 0;
    const { dispatcher } = makeDispatcher({
      fetchFn: async () => {
        calls += 1;
        return calls === 1 ? new Response('bad request', { status: 400 }) : new Response(null, { status: 202 });
      },
    });
    (dispatcher as unknown as { capacityState: DerivedCapacity }).capacityState = {
      runningContainers: 100,
      maxInFlight: 4,
      t0Reserved: 2,
      sharedPool: 2,
      t2Ceiling: 1,
      dailyRuns: 100,
      dailyPages: 100,
      dailyByBucket: { t0: 1, t1: 40, t2: 20 },
    };

    const internal = dispatcher as unknown as { considerDueIncident(incident: Incident, now: number): void };
    const first = makeIncident({ id: 'inc-first', tier: 0, lane: 'triage', entityIds: ['host1/a'], primaryEntityId: 'host1/a' }, { tier: 0 });
    internal.considerDueIncident(first, BASE_AT);
    await (dispatcher as unknown as { waitForIdle(): Promise<void> }).waitForIdle();

    // With only 1 slot in the t0 bucket, a second dispatch only gets through if the first
    // (rejected) attempt released its reservation instead of leaving the bucket permanently
    // "spent".
    const second = makeIncident({ id: 'inc-second', tier: 0, lane: 'triage', entityIds: ['host1/b'], primaryEntityId: 'host1/b' }, { tier: 0 });
    internal.considerDueIncident(second, BASE_AT + 1);
    await (dispatcher as unknown as { waitForIdle(): Promise<void> }).waitForIdle();

    expect(calls).toBe(2);
  });

  it('does not mark an incident dispatched when the immediate page is blocked by an exhausted budget', () => {
    const { dispatcher } = makeDispatcher({});
    (dispatcher as unknown as { capacityState: DerivedCapacity }).capacityState = {
      runningContainers: 100,
      maxInFlight: 4,
      t0Reserved: 2,
      sharedPool: 2,
      t2Ceiling: 1,
      dailyRuns: 100,
      dailyPages: 0,
      dailyByBucket: { t0: 40, t1: 40, t2: 20 },
    };

    dispatcher.submit(makeSignal({ tier: 0, lane: 'page', entityId: 'host1/blocked' }));

    const internal = dispatcher as unknown as { coalescer: { open(): Incident[] } };
    const incident = internal.coalescer.open()[0];
    expect(incident).toBeDefined();
    expect(incident.state).toBe('open');
    expect(incident.dispatchedAt).toBeNull();
  });

  it('ensureBudgetLoaded merges a pending reservation so a stale load() cannot clobber an in-flight increment()', async () => {
    let resolveLoad!: (v: Record<BudgetBucket, number>) => void;
    const loadGate = new Promise<Record<BudgetBucket, number>>((resolve) => {
      resolveLoad = resolve;
    });
    const budgetStore: BudgetStore = {
      load: () => loadGate,
      increment: async () => {},
    };
    const { dispatcher } = makeDispatcher({ budgetStore });
    const internal = dispatcher as unknown as {
      pendingSpend: Record<BudgetBucket, number>;
      spentToday: Record<BudgetBucket, number>;
      ensureBudgetLoaded(now: number): Promise<void>;
    };

    // Simulate a reservation still in flight (its increment() hasn't resolved yet) at the
    // moment a day-rollover reload's load() call resolves with the store's pre-increment state.
    internal.pendingSpend.page = 1;

    const loaded = internal.ensureBudgetLoaded(BASE_AT);
    resolveLoad({ t0: 0, t1: 0, t2: 0, page: 0 });
    await loaded;

    expect(internal.spentToday.page).toBe(1);
  });
});

describe('HermesDispatcher submit/tick/capacity wiring', () => {
  let originalSetTimeout: typeof setTimeout;

  beforeEach(() => {
    originalSetTimeout = globalThis.setTimeout;
    spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
  });

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout;
  });

  it('recomputes capacity from the running-container count reported by watchers', () => {
    const { dispatcher } = makeDispatcher({});
    dispatcher.setRunningContainerCount('host1', 100);
    const cap = dispatcher.capacity();
    expect(cap.runningContainers).toBe(100);
    expect(cap.maxInFlight).toBe(4);
    dispatcher.setRunningContainerCount('host2', 50);
    expect(dispatcher.capacity().runningContainers).toBe(150);
  });

  it('fires a page signal immediately end to end via submit(), delivering exactly once', async () => {
    let calls = 0;
    const capturedRequestIds: string[] = [];
    const { dispatcher } = makeDispatcher({
      fetchFn: async (_url, init) => {
        calls += 1;
        const headers = init?.headers as Record<string, string>;
        capturedRequestIds.push(headers['X-Request-ID']);
        return new Response(null, { status: 202 });
      },
    });
    dispatcher.setRunningContainerCount('host1', 100);

    const pageSignal = makeSignal({ tier: 0, lane: 'page', entityId: 'host1/critical' });
    dispatcher.submit(pageSignal);

    await (dispatcher as unknown as { waitForIdle(): Promise<void> }).waitForIdle();

    expect(calls).toBe(1);
    expect(capturedRequestIds[0]).toMatch(/^inc-e-.*-1$/);
  });

  it('reports stats reflecting queued/in-flight/spent/circuit state', async () => {
    const { dispatcher } = makeDispatcher({
      fetchFn: async () => new Response(null, { status: 202 }),
    });
    dispatcher.setRunningContainerCount('host1', 100);
    const stats = dispatcher.stats();
    expect(stats.queued).toEqual({ page: 0, t0: 0, t1: 0, t2: 0 });
    expect(stats.circuitOpenRoutes).toEqual([]);
    expect(stats.openIncidents).toBe(0);
  });

  it('drops the oldest queued entry once a lane FIFO exceeds MAX_QUEUED_PER_LANE', async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(' '));

    try {
      let resolveGate!: () => void;
      const gatePromise = new Promise<void>((resolve) => {
        resolveGate = resolve;
      });
      let calls = 0;
      const { dispatcher } = makeDispatcher({
        fetchFn: async () => {
          calls += 1;
          if (calls === 1) await gatePromise;
          return new Response(null, { status: 202 });
        },
      });
      dispatcher.setRunningContainerCount('host1', 25);

      const internal = dispatcher as unknown as {
        enqueue(key: 'page' | 't0' | 't1' | 't2', entry: ReturnType<typeof entryFor>): void;
        fifos: Record<'page' | 't0' | 't1' | 't2', unknown[]>;
      };

      for (let i = 0; i < 105; i++) {
        const incident = makeIncident(
          { id: `inc-overflow-${i}`, tier: 2, lane: 'triage', entityIds: [`host1/c${i}`], primaryEntityId: `host1/c${i}` },
          { tier: 2, entityId: `host1/c${i}` },
        );
        internal.enqueue('t2', entryFor(incident));
      }

      expect(internal.fifos.t2.length).toBeLessThanOrEqual(100);
      resolveGate();
      await (dispatcher as unknown as { waitForIdle(): Promise<void> }).waitForIdle();
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings.some((w) => w.includes('queue overflow'))).toBe(true);
  });

  it('disposes cleanly: stops the interval and settles pending work without hanging', async () => {
    const { dispatcher } = makeDispatcher({
      fetchFn: async () => new Response(null, { status: 202 }),
    });
    dispatcher.start();
    await dispatcher[Symbol.asyncDispose]();
  });

  it('dispatches a due triage incident through submit()+tick(), delivering via the correct route', async () => {
    let calls = 0;
    let capturedUrl = '';
    const clock = fakeClock(BASE_AT);
    const { dispatcher } = makeDispatcher({
      clock,
      fetchFn: async (url) => {
        calls += 1;
        capturedUrl = String(url);
        return new Response(null, { status: 202 });
      },
    });
    dispatcher.setRunningContainerCount('host1', 100);

    dispatcher.submit(makeSignal({ tier: 1, lane: 'triage', entityId: 'host1/tickme', stackProject: null }));
    clock.advance(30_000);
    await dispatcher.tick(clock.now());
    await (dispatcher as unknown as { waitForIdle(): Promise<void> }).waitForIdle();

    expect(calls).toBe(1);
    expect(capturedUrl).toContain('homelab-log-triage-t1');
  });

  it('routes a debounced followup through the tier triage route, not the page route, after the incident already paged once', async () => {
    const urls: string[] = [];
    const clock = fakeClock(BASE_AT);
    const { dispatcher } = makeDispatcher({
      clock,
      fetchFn: async (url) => {
        urls.push(String(url));
        return new Response(null, { status: 202 });
      },
    });
    dispatcher.setRunningContainerCount('host1', 100);

    dispatcher.submit(
      makeSignal({ tier: 0, lane: 'page', entityId: 'host1/critical', ruleIds: ['rule-a'], ruleNames: ['Rule A'], decidingRuleId: 'rule-a' }),
    );
    await (dispatcher as unknown as { waitForIdle(): Promise<void> }).waitForIdle();
    expect(urls).toEqual(['https://hermes.example.com/webhooks/homelab-page-t0']);

    clock.advance(1_000);
    dispatcher.submit(
      makeSignal({ tier: 0, lane: 'triage', entityId: 'host1/critical', ruleIds: ['rule-b'], ruleNames: ['Rule B'], decidingRuleId: 'rule-b' }),
    );

    clock.advance(60_000);
    await dispatcher.tick(clock.now());
    await (dispatcher as unknown as { waitForIdle(): Promise<void> }).waitForIdle();

    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('homelab-log-triage-t0');
  });

  it('delivers a payload snapshot taken at enqueue time, unaffected by a signal joining the same incident before delivery completes', async () => {
    let resolveFetch!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveFetch = resolve;
    });
    let capturedBody = '';
    const { dispatcher } = makeDispatcher({
      fetchFn: async (_url, init) => {
        await gate;
        capturedBody = String(init?.body ?? '');
        return new Response(null, { status: 202 });
      },
    });
    dispatcher.setRunningContainerCount('host1', 100);

    const internal = dispatcher as unknown as {
      considerDueIncident(incident: Incident, now: number): void;
      coalescer: { open(): Incident[] };
    };

    dispatcher.submit(makeSignal({ tier: 1, lane: 'triage', entityId: 'host1/drift', stackProject: null }));
    const incident = internal.coalescer.open()[0];
    internal.considerDueIncident(incident, BASE_AT);

    // A more severe signal joins the same live incident while its delivery is still in flight.
    dispatcher.submit(makeSignal({ tier: 0, lane: 'triage', entityId: 'host1/drift', stackProject: null }));

    resolveFetch();
    await (dispatcher as unknown as { waitForIdle(): Promise<void> }).waitForIdle();

    const body = JSON.parse(capturedBody) as { tier: number };
    expect(body.tier).toBe(1);
  });

  it('does not re-queue an incident that is already queued or in flight', async () => {
    let calls = 0;
    let resolveFetch!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveFetch = resolve;
    });
    const { dispatcher } = makeDispatcher({
      fetchFn: async () => {
        calls += 1;
        await gate;
        return new Response(null, { status: 202 });
      },
    });
    dispatcher.setRunningContainerCount('host1', 100);
    const internal = dispatcher as unknown as {
      considerDueIncident(incident: Incident, now: number): void;
      inFlightIncidentIds: Set<string>;
    };
    const incident = makeIncident(
      { id: 'inc-dup', tier: 1, lane: 'triage', entityIds: ['host1/cX'], primaryEntityId: 'host1/cX' },
      { tier: 1 },
    );
    internal.considerDueIncident(incident, BASE_AT);
    expect(internal.inFlightIncidentIds.has('inc-dup')).toBe(true);

    internal.considerDueIncident(incident, BASE_AT + 10);

    resolveFetch();
    await (dispatcher as unknown as { waitForIdle(): Promise<void> }).waitForIdle();
    expect(calls).toBe(1);
  });

  it('parks acquireCapacity when the gate refuses, and release resolves the oldest waiter', async () => {
    const { dispatcher } = makeDispatcher({});
    const internal = dispatcher as unknown as {
      acquireCapacity(tier: 0 | 1 | 2): Promise<void>;
      releaseCapacity(tier: 0 | 1 | 2): void;
      gate: CapacityGate;
    };
    internal.gate = new CapacityGate({
      runningContainers: 1,
      maxInFlight: 1,
      t0Reserved: 1,
      sharedPool: 1,
      t2Ceiling: 1,
      dailyRuns: 10,
      dailyPages: 10,
      dailyByBucket: { t0: 5, t1: 5, t2: 5 },
    });

    await internal.acquireCapacity(0);
    let resolved = false;
    const waiter = internal.acquireCapacity(1).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    internal.releaseCapacity(0);
    await waiter;
    expect(resolved).toBe(true);
  });

  it('resets spend to zero and logs when the budget store fails to load', async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.join(' '));
    };
    try {
      const budgetStore: BudgetStore = {
        load: async () => {
          throw new Error('db down');
        },
        increment: async () => {},
      };
      const { dispatcher } = makeDispatcher({ budgetStore });
      await dispatcher.tick(BASE_AT);
    } finally {
      console.error = originalError;
    }
    expect(errors.some((e) => e.includes('failed to load budget'))).toBe(true);
  });

  it('logs and continues when persisting a budget spend fails', async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.join(' '));
    };
    try {
      const budgetStore: BudgetStore = {
        load: async () => ({ t0: 0, t1: 0, t2: 0, page: 0 }),
        increment: async () => {
          throw new Error('increment failed');
        },
      };
      const { dispatcher } = makeDispatcher({
        budgetStore,
        fetchFn: async () => new Response(null, { status: 202 }),
      });
      dispatcher.setRunningContainerCount('host1', 100);
      dispatcher.submit(makeSignal({ tier: 0, lane: 'page', entityId: 'host1/spend' }));
      await (dispatcher as unknown as { waitForIdle(): Promise<void> }).waitForIdle();
    } finally {
      console.error = originalError;
    }
    expect(errors.some((e) => e.includes('failed to persist budget spend'))).toBe(true);
  });
});
