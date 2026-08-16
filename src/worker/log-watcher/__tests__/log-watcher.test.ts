import { describe, expect, it, mock, spyOn } from 'bun:test';
import { fixedStream, type StreamConnector } from '@/lib/test/agent-sse-stream-fixtures';
import { LogWatcher } from '@/worker/log-watcher/log-watcher';
import type {
  DetectorRuleRepository,
  DockerContainerEventRepository,
  EntityMetadataRepository,
  LogBaselineRepository,
  LogShapeRepository,
  LogWatcherDeps,
  LogWatcherHost,
} from '@/worker/log-watcher/log-watcher';
import type { LogSignal } from '@/worker/log-watcher/types';
import type { DetectorRuleRecord, RuleKind, RuleOrigin, RuleState } from '@/lib/database/repositories/detector-rule-repository';
import type {
  LogShapeRecord,
  RecordShapeBucketInput,
  RecordShapeOccurrenceInput,
} from '@/lib/database/repositories/log-shape-repository';
import type { DockerContainerEventUpsertRow } from '@/lib/database/repositories/docker-container-event-repository';
import type { LogLane, Tier } from '@/lib/logs/types';
import type { RuleMatcher, RuleScope } from '@/lib/logs/rules';
import { COLD_START_MS } from '@/lib/logs/baseline';

const HOST: LogWatcherHost = { name: 'server1', agentUrl: 'http://192.168.1.10:9090' };

function makeClock(startMs: number) {
  const state = { value: startMs };
  return {
    clock: { now: () => state.value },
    advance(ms: number) {
      state.value += ms;
    },
    set(ms: number) {
      state.value = ms;
    },
  };
}

function makeUpsertRow(overrides: Partial<DockerContainerEventUpsertRow> = {}): DockerContainerEventUpsertRow {
  return {
    at: new Date('2026-01-01T00:00:00Z'),
    host: HOST.name,
    containerId: 'c1',
    eventType: 'upsert',
    state: 'running',
    name: 'jellyfin',
    image: 'jellyfin/jellyfin:latest',
    labels: {},
    ports: [],
    mounts: [],
    composeProject: null,
    serviceKey: null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    ...overrides,
  };
}

let ruleSeq = 0;
function makeRuleRecord(overrides: {
  id?: string;
  kind?: RuleKind;
  matcher?: RuleMatcher;
  lane?: LogLane;
  appliesToTiers?: readonly Tier[] | null;
  hardSignal?: boolean;
  scope?: RuleScope;
  state?: RuleState;
}): DetectorRuleRecord {
  ruleSeq += 1;
  return {
    id: overrides.id ?? `rule-${ruleSeq}`,
    version: 1,
    name: overrides.id ?? `rule-${ruleSeq}`,
    kind: overrides.kind ?? 'match',
    matcher: overrides.matcher ?? { type: 'literal', needle: 'TRIGGER', caseSensitive: true, target: 'raw', stream: 'any' },
    lane: overrides.lane ?? 'triage',
    state: overrides.state ?? 'active',
    enabled: true,
    scope: overrides.scope ?? { kind: 'fleet' },
    appliesToTiers: overrides.appliesToTiers ?? null,
    priority: 0,
    hardSignal: overrides.hardSignal ?? true,
    operatorApproved: true,
    canaryUntil: null,
    cooldownMs: null,
    provenance: {
      origin: 'seed' as RuleOrigin,
      proposedByRunId: null,
      proposedFromFindingId: null,
      rationale: 'test',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      promotedAt: null,
    },
  };
}

function makeShapeRecord(overrides: Partial<LogShapeRecord> & { entityId: string; shapeId: string; template: string }): LogShapeRecord {
  return {
    firstSeenAt: new Date('2026-01-01T00:00:00Z'),
    lastSeenAt: new Date('2026-01-01T00:00:00Z'),
    totalCount: 1,
    lane: 'batch',
    laneSource: 'default',
    laneUpdatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

interface FakeRepos {
  deps: LogWatcherDeps;
  signals: LogSignal[];
  rows: DockerContainerEventUpsertRow[];
  rules: DetectorRuleRecord[];
  metadata: Map<string, Map<string, string>>;
  shapesByEntity: Map<string, LogShapeRecord[]>;
  listShapesCalls: string[];
  occurrences: RecordShapeOccurrenceInput[];
  buckets: RecordShapeBucketInput[];
  savedBaselines: { entityId: string; state: string }[];
  loadManyCalls: readonly string[][];
  failNextOccurrence: { value: boolean };
  failures: {
    listShapes: boolean;
    listEvaluableRules: boolean;
    getEntityMetadata: boolean;
    getCurrentSnapshot: boolean;
    loadMany: boolean;
    saveMany: boolean;
  };
}

function createFakeRepos(clock: { now: () => number }): FakeRepos {
  const signals: LogSignal[] = [];
  const rows: DockerContainerEventUpsertRow[] = [];
  const rules: DetectorRuleRecord[] = [];
  const metadata = new Map<string, Map<string, string>>();
  const shapesByEntity = new Map<string, LogShapeRecord[]>();
  const listShapesCalls: string[] = [];
  const occurrences: RecordShapeOccurrenceInput[] = [];
  const buckets: RecordShapeBucketInput[] = [];
  const savedBaselines: { entityId: string; state: string }[] = [];
  const loadManyCallsMut: string[][] = [];
  const failNextOccurrence = { value: false };
  const failures = {
    listShapes: false,
    listEvaluableRules: false,
    getEntityMetadata: false,
    getCurrentSnapshot: false,
    loadMany: false,
    saveMany: false,
  };

  const logShapeRepository: LogShapeRepository = {
    async listShapes(entityId) {
      listShapesCalls.push(entityId);
      if (failures.listShapes) throw new Error('listShapes failed');
      return shapesByEntity.get(entityId) ?? [];
    },
    async recordShapeOccurrence(input) {
      if (failNextOccurrence.value) {
        failNextOccurrence.value = false;
        throw new Error('db unavailable');
      }
      occurrences.push(input);
    },
    async recordShapeBucket(input) {
      buckets.push(input);
    },
  };

  const detectorRuleRepository: DetectorRuleRepository = {
    async listEvaluableRules() {
      if (failures.listEvaluableRules) throw new Error('listEvaluableRules failed');
      return rules;
    },
  };

  const entityMetadataRepository: EntityMetadataRepository = {
    async getEntityMetadata(entities) {
      if (failures.getEntityMetadata) throw new Error('getEntityMetadata failed');
      const out = new Map<string, Map<string, string>>();
      for (const e of entities) {
        const m = metadata.get(e);
        if (m) out.set(e, m);
      }
      return out;
    },
  };

  const containerEventRepository: DockerContainerEventRepository = {
    async getCurrentSnapshot() {
      if (failures.getCurrentSnapshot) throw new Error('getCurrentSnapshot failed');
      return rows;
    },
  };

  const baselineRepository: LogBaselineRepository = {
    async loadMany(entityIds) {
      loadManyCallsMut.push([...entityIds]);
      if (failures.loadMany) throw new Error('loadMany failed');
      return new Map();
    },
    async saveMany(entries) {
      if (failures.saveMany) throw new Error('saveMany failed');
      savedBaselines.push(...entries);
    },
  };

  const deps: LogWatcherDeps = {
    logShapeRepository,
    detectorRuleRepository,
    entityMetadataRepository,
    containerEventRepository,
    baselineRepository,
    onSignal: (s) => signals.push(s),
    clock,
  };

  return {
    deps,
    signals,
    rows,
    rules,
    metadata,
    shapesByEntity,
    listShapesCalls,
    occurrences,
    buckets,
    savedBaselines,
    get loadManyCalls() {
      return loadManyCallsMut;
    },
    failNextOccurrence,
    failures,
  };
}

function makeWatcher(repos: FakeRepos, streamConnector: StreamConnector, abortController = new AbortController()) {
  return new LogWatcher(HOST, async () => 'token', { ...repos.deps, streamConnector }, abortController);
}

/** Letters-only marker: shape.ts folds a trailing digit run into <N>, so a numeric
 * suffix (`token0`, `token1`, ...) collapses every line into one shape. */
function distinctWord(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    n -= 1;
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

function makeLogFrame(overrides: { containerId?: string; text?: string; at?: string | null; stream?: 'stdout' | 'stderr' } = {}) {
  return {
    containerId: overrides.containerId ?? 'c1',
    containerName: 'jellyfin',
    at: overrides.at === undefined ? '2026-01-01T00:00:05Z' : overrides.at,
    stream: overrides.stream ?? 'stdout',
    text: overrides.text ?? 'a routine log line',
  };
}

describe('LogWatcher', () => {
  it('has the correct name', () => {
    const { clock } = makeClock(0);
    const repos = createFakeRepos(clock);
    const watcher = makeWatcher(repos, fixedStream([]));
    expect(watcher.name).toBe('LogWatcher[server1]');
  });

  it('drops a log line for an entity the reconcile has not admitted yet', async () => {
    const { clock } = makeClock(1_000_000);
    const repos = createFakeRepos(clock);
    repos.rows.length = 0; // no containers known
    const watcher = makeWatcher(repos, fixedStream([makeLogFrame()]));

    await (watcher as any).collect();

    expect(repos.signals).toHaveLength(0);
    expect(watcher.stats().linesDropped).toBe(1);
    expect(watcher.stats().linesSeen).toBe(1);
    expect(watcher.stats().entities).toBe(0);
  });

  it('ignores a malformed frame without counting it as seen', async () => {
    const { clock } = makeClock(0);
    const repos = createFakeRepos(clock);
    const watcher = makeWatcher(repos, fixedStream([null, 42, { foo: 'bar' }]));

    await (watcher as any).collect();

    expect(watcher.stats().linesSeen).toBe(0);
    expect(watcher.stats().linesDropped).toBe(0);
  });

  describe('lane routing', () => {
    it('a matched rule on a tier-0 container pages', async () => {
      const { clock } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      repos.metadata.set(`${HOST.name}/c1`, new Map([['criticality', '0']]));
      repos.rules.push(
        makeRuleRecord({
          id: 'page-rule',
          lane: 'page',
          appliesToTiers: [0],
          matcher: { type: 'literal', needle: 'PAGE_TRIGGER', caseSensitive: true, target: 'raw', stream: 'any' },
        }),
      );
      const watcher = makeWatcher(repos, fixedStream([makeLogFrame({ text: 'PAGE_TRIGGER seen' })]));

      await (watcher as any).collect();

      expect(repos.signals).toHaveLength(1);
      expect(repos.signals[0].lane).toBe('page');
      expect(repos.signals[0].tier).toBe(0);
      expect(repos.signals[0].hardSignal).toBe(true);
      expect(repos.signals[0].decidingRuleId).toBe('page-rule');
    });

    it('a matched rule on any tier triages', async () => {
      const { clock } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      repos.rules.push(
        makeRuleRecord({
          id: 'triage-rule',
          lane: 'triage',
          matcher: { type: 'literal', needle: 'TRIAGE_TRIGGER', caseSensitive: true, target: 'raw', stream: 'any' },
        }),
      );
      const watcher = makeWatcher(repos, fixedStream([makeLogFrame({ text: 'TRIAGE_TRIGGER seen' })]));

      await (watcher as any).collect();

      expect(repos.signals).toHaveLength(1);
      expect(repos.signals[0].lane).toBe('triage');
    });

    it('an unrouted line with no rule match falls to the batch lane and never reaches onSignal', async () => {
      const { clock } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      const watcher = makeWatcher(repos, fixedStream([makeLogFrame({ text: 'nothing interesting here' })]));

      await (watcher as any).collect();

      expect(repos.signals).toHaveLength(0);
    });

    it('a shape already routed to count by the agent never reaches onSignal', async () => {
      const { clock } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      const entityId = `${HOST.name}/c1`;
      const text = 'ffmpeg: stream 0:1 dropped 47 frames';
      const { normalizeLogLine } = await import('@/lib/logs/shape');
      const shapeId = normalizeLogLine(text).shapeId;
      repos.shapesByEntity.set(entityId, [
        makeShapeRecord({ entityId, shapeId, template: normalizeLogLine(text).template, lane: 'count', laneSource: 'agent' }),
      ]);
      const watcher = makeWatcher(repos, fixedStream([makeLogFrame({ text })]));

      await (watcher as any).collect();

      expect(repos.signals).toHaveLength(0);
    });

    it('a rule beats a stored count route for the same shape', async () => {
      const { clock } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      const entityId = `${HOST.name}/c1`;
      const text = 'PANIC: kernel oops';
      const { normalizeLogLine } = await import('@/lib/logs/shape');
      const shapeId = normalizeLogLine(text).shapeId;
      repos.shapesByEntity.set(entityId, [
        makeShapeRecord({ entityId, shapeId, template: normalizeLogLine(text).template, lane: 'count', laneSource: 'agent' }),
      ]);
      repos.rules.push(
        makeRuleRecord({
          id: 'panic-rule',
          lane: 'triage',
          matcher: { type: 'regex', pattern: '\\bPANIC\\b', flags: '', target: 'raw', stream: 'any' },
        }),
      );
      const watcher = makeWatcher(repos, fixedStream([makeLogFrame({ text })]));

      await (watcher as any).collect();

      expect(repos.signals).toHaveLength(1);
      expect(repos.signals[0].lane).toBe('triage');
    });
  });

  describe('shape cache', () => {
    it('resolves repeated lines of the same shape without a per-line DB round trip', async () => {
      const { clock } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      const frames = Array.from({ length: 50 }, () => makeLogFrame({ text: 'repeated line 42' }));
      const watcher = makeWatcher(repos, fixedStream(frames));

      await (watcher as any).collect();

      // listShapes is called exactly once per entity, at admission (reconcile hydration),
      // not once per line despite 50 lines sharing the same shape.
      expect(repos.listShapesCalls.filter((id) => id === `${HOST.name}/c1`)).toHaveLength(1);
      // The final flush (collect()'s finally) aggregates all 50 lines into one write.
      expect(repos.occurrences).toHaveLength(1);
      expect(repos.occurrences[0].count).toBe(50);
    });

    it('flushes rollups on the tick cadence with the aggregated count', async () => {
      const { clock, advance } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      const entityId = `${HOST.name}/c1`;
      const watcher = makeWatcher(repos, fixedStream([]));

      await (watcher as any).collect();
      for (let i = 0; i < 5; i++) {
        (watcher as any).handleFrame(makeLogFrame({ text: 'repeated line 42', at: null }));
      }

      advance(11_000);
      await watcher.tick(clock.now());

      expect(repos.occurrences).toHaveLength(1);
      expect(repos.occurrences[0].entityId).toBe(entityId);
      expect(repos.occurrences[0].count).toBe(5);
      expect(repos.buckets).toHaveLength(1);
      expect(repos.buckets[0].count).toBe(5);
      expect(repos.buckets[0].exemplars.length).toBeGreaterThan(0);
    });

    it('keeps a shape dirty for retry when the flush write fails', async () => {
      const { clock, advance } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      const watcher = makeWatcher(repos, fixedStream([]));
      await (watcher as any).collect();

      (watcher as any).handleFrame(makeLogFrame({ text: 'will fail once' }));
      repos.failNextOccurrence.value = true;

      const origError = console.error;
      console.error = () => {};
      try {
        advance(11_000);
        await watcher.tick(clock.now());
      } finally {
        console.error = origError;
      }
      expect(repos.occurrences).toHaveLength(0);

      advance(11_000);
      await watcher.tick(clock.now());
      expect(repos.occurrences).toHaveLength(1);
      expect(repos.occurrences[0].count).toBe(1);
    });
  });

  describe('MAX_SHAPES_PER_ENTITY enforcement', () => {
    it('folds the 469th unique shape into a coarse entry once the fine budget is exhausted', async () => {
      const { clock } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      const watcher = makeWatcher(repos, fixedStream([]));
      await (watcher as any).collect();

      for (let i = 0; i < 469; i++) {
        (watcher as any).handleFrame(makeLogFrame({ text: `marker ${distinctWord(i)} distinct` }));
      }

      const entityId = `${HOST.name}/c1`;
      const state = (watcher as any).entities.get(entityId);
      expect(state.shapes.fine.size).toBe(468);
      expect(state.shapes.coarse.size).toBe(1);
      expect(state.shapes.overflow).toBeNull();
    });

    it('folds into the overflow entry once both the fine and coarse budgets are exhausted', async () => {
      const { clock } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      const watcher = makeWatcher(repos, fixedStream([]));
      await (watcher as any).collect();

      const entityId = `${HOST.name}/c1`;
      const state = (watcher as any).entities.get(entityId);
      for (let i = 0; i < 468; i++) {
        state.shapes.fine.set(`fine-${i}`, {
          entityId, shapeId: `fine-${i}`, template: `fine ${i}`, lane: 'batch', laneSource: 'default',
          firstSeenAt: 0, lastSeenAt: 0, buckets: new Map(), dirty: false,
        });
      }
      for (let i = 0; i < 32; i++) {
        state.shapes.coarse.set(`coarse-${i}`, {
          entityId, shapeId: `coarse-${i}`, template: `~coarse ${i}`, lane: 'batch', laneSource: 'default',
          firstSeenAt: 0, lastSeenAt: 0, buckets: new Map(), dirty: false,
        });
      }

      (watcher as any).handleFrame(makeLogFrame({ text: 'brand new distinct overflow line' }));

      expect(state.shapes.overflow).not.toBeNull();
      expect(state.shapes.overflow.lane).toBe('count');
      expect(state.shapes.overflow.laneSource).toBe('overflow');
    });

    it('a PANIC line whose shape folded into overflow still emits a triage signal', async () => {
      const { clock } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      repos.rules.push(
        makeRuleRecord({
          id: 'panic-rule',
          lane: 'triage',
          matcher: { type: 'regex', pattern: '\\bPANIC\\b', flags: '', target: 'raw', stream: 'any' },
        }),
      );
      const watcher = makeWatcher(repos, fixedStream([]));
      await (watcher as any).collect();

      const entityId = `${HOST.name}/c1`;
      const state = (watcher as any).entities.get(entityId);
      for (let i = 0; i < 468; i++) {
        state.shapes.fine.set(`fine-${i}`, {
          entityId, shapeId: `fine-${i}`, template: `fine ${i}`, lane: 'batch', laneSource: 'default',
          firstSeenAt: 0, lastSeenAt: 0, buckets: new Map(), dirty: false,
        });
      }
      for (let i = 0; i < 32; i++) {
        state.shapes.coarse.set(`coarse-${i}`, {
          entityId, shapeId: `coarse-${i}`, template: `~coarse ${i}`, lane: 'batch', laneSource: 'default',
          firstSeenAt: 0, lastSeenAt: 0, buckets: new Map(), dirty: false,
        });
      }

      (watcher as any).handleFrame(makeLogFrame({ text: 'PANIC: kernel oops, unique overflow trigger' }));

      expect(repos.signals).toHaveLength(1);
      expect(repos.signals[0].lane).toBe('triage');
      expect(repos.signals[0].hardSignal).toBe(true);
      expect(state.shapes.overflow).not.toBeNull();
    });
  });

  describe('inventory reconciliation', () => {
    it('admits a newly seen running container, hydrating its shapes and baseline', async () => {
      const { clock } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      const watcher = makeWatcher(repos, fixedStream([]));

      await (watcher as any).collect();

      expect(watcher.stats().entities).toBe(1);
      const entityId = `${HOST.name}/c1`;
      expect(repos.listShapesCalls).toContain(entityId);
      expect(repos.loadManyCalls.some((ids) => ids.includes(entityId))).toBe(true);
    });

    it('reports the running-entity count via onRunningCountChange after each reconcile', async () => {
      const { clock, advance } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      repos.rows.push(makeUpsertRow({ containerId: 'c2' }));
      const runningCounts: number[] = [];
      const watcher = new LogWatcher(
        HOST,
        async () => 'token',
        { ...repos.deps, onRunningCountChange: (n) => runningCounts.push(n), streamConnector: fixedStream([]) },
        new AbortController(),
      );

      await (watcher as any).collect();
      expect(runningCounts).toEqual([2]);

      repos.rows.length = 0;
      repos.rows.push(makeUpsertRow({ containerId: 'c1', state: 'exited', exitCode: 0 }));
      repos.rows.push(makeUpsertRow({ containerId: 'c2' }));
      advance(31_000);
      await watcher.tick(clock.now());

      expect(runningCounts).toEqual([2, 1]);
    });

    it('drops an entity that stops running, flushing pending rollups and persisting its baseline', async () => {
      const { clock, advance } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      const watcher = makeWatcher(repos, fixedStream([]));
      await (watcher as any).collect();

      (watcher as any).handleFrame(makeLogFrame({ text: 'about to disappear' }));
      expect(watcher.stats().entities).toBe(1);

      repos.rows.length = 0;
      repos.rows.push(makeUpsertRow({ containerId: 'c1', state: 'exited', exitCode: 0 }));

      advance(31_000);
      await watcher.tick(clock.now());

      expect(watcher.stats().entities).toBe(0);
      const entityId = `${HOST.name}/c1`;
      expect(repos.savedBaselines.some((b) => b.entityId === entityId)).toBe(true);
      expect(repos.occurrences.some((o) => o.entityId === entityId)).toBe(true);
    });

    it('drops an entity that is removed from the inventory entirely', async () => {
      const { clock, advance } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      const watcher = makeWatcher(repos, fixedStream([]));
      await (watcher as any).collect();
      expect(watcher.stats().entities).toBe(1);

      repos.rows.length = 0;

      advance(31_000);
      await watcher.tick(clock.now());

      expect(watcher.stats().entities).toBe(0);
    });

    it('picks up a dropped line for a not-yet-known entity on the next reconcile', async () => {
      const { clock, advance } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.length = 0;
      const watcher = makeWatcher(repos, fixedStream([]));
      await (watcher as any).collect();

      (watcher as any).handleFrame(makeLogFrame());
      expect(watcher.stats().linesDropped).toBe(1);
      expect((watcher as any).inventoryDirty).toBe(true);

      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      advance(1_000);
      await watcher.tick(clock.now());

      expect(watcher.stats().entities).toBe(1);
      expect((watcher as any).inventoryDirty).toBe(false);
    });

    it('resets the baseline and tracks sinceImageChangeMs when the image changes', async () => {
      const { clock, advance } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1', image: 'jellyfin/jellyfin:1' }));
      repos.rules.push(
        makeRuleRecord({
          id: 'triage-rule',
          lane: 'triage',
          matcher: { type: 'literal', needle: 'TRIGGER', caseSensitive: true, target: 'raw', stream: 'any' },
        }),
      );
      const watcher = makeWatcher(repos, fixedStream([]));
      await (watcher as any).collect();

      repos.rows.length = 0;
      repos.rows.push(makeUpsertRow({ containerId: 'c1', image: 'jellyfin/jellyfin:2' }));
      advance(31_000);
      await watcher.tick(clock.now());

      advance(5_000);
      (watcher as any).handleFrame(makeLogFrame({ text: 'TRIGGER fired', at: null }));

      expect(repos.signals).toHaveLength(1);
      expect(repos.signals[0].sinceImageChangeMs).toBe(5_000);
    });

    it('emits a triage signal for a non-zero exit state event', async () => {
      const { clock, advance } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      repos.rules.push(
        makeRuleRecord({
          id: 'nonzero-exit',
          kind: 'state',
          lane: 'triage',
          matcher: { type: 'event', eventTypes: ['die'], exitCodeNonZero: true },
        }),
      );
      const watcher = makeWatcher(repos, fixedStream([]));
      await (watcher as any).collect();

      repos.rows.length = 0;
      repos.rows.push(makeUpsertRow({ containerId: 'c1', state: 'exited', exitCode: 137 }));
      advance(31_000);
      await watcher.tick(clock.now());

      expect(repos.signals).toHaveLength(1);
      expect(repos.signals[0].trigger).toBe('event');
      expect(repos.signals[0].event?.exitCode).toBe(137);
    });

    it('does not emit for a state transition with no matching rule', async () => {
      const { clock, advance } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      const watcher = makeWatcher(repos, fixedStream([]));
      await (watcher as any).collect();

      repos.rows.length = 0;
      repos.rows.push(makeUpsertRow({ containerId: 'c1', state: 'exited', exitCode: 0 }));
      advance(31_000);
      await watcher.tick(clock.now());

      expect(repos.signals).toHaveLength(0);
    });

    it('counts restarts within the window, pruning entries older than 10 minutes', async () => {
      const { clock, advance } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      repos.rules.push(
        makeRuleRecord({
          id: 'crash-loop',
          kind: 'state',
          lane: 'triage',
          matcher: { type: 'event', eventTypes: ['start'], minRestartsInWindow: 2 },
        }),
      );
      const watcher = makeWatcher(repos, fixedStream([]));
      await (watcher as any).collect();

      const entityId = `${HOST.name}/c1`;
      const state = (watcher as any).entities.get(entityId);
      // One restart from 11 minutes ago (outside the 10-minute ring) and one from
      // just now, exercising the prune-then-push path on a non-empty array.
      advance(660_000);
      state.restartTimestamps = [clock.now() - 660_000];

      (watcher as any).handleStateTransition(entityId, state, 'exited', 'running', makeUpsertRow({ state: 'running' }), clock.now());

      expect(state.restartTimestamps).toHaveLength(1);
      const crashSignal = repos.signals.find((s) => s.decidingRuleId === 'crash-loop');
      expect(crashSignal).toBeUndefined();

      (watcher as any).handleStateTransition(entityId, state, 'exited', 'running', makeUpsertRow({ state: 'running' }), clock.now());
      const secondSignal = repos.signals.find((s) => s.decidingRuleId === 'crash-loop');
      expect(secondSignal).toBeDefined();
      expect(secondSignal?.event?.restartsInWindow).toBe(2);
    });
  });

  describe('rule refresh', () => {
    it('skips a rule with a malformed matcher and logs once', async () => {
      const { clock } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      repos.rules.push({
        ...makeRuleRecord({ id: 'bad-rule' }),
        matcher: { type: 'literal', needle: 42 } as unknown as RuleMatcher,
      });
      const watcher = makeWatcher(repos, fixedStream([]));

      const errors: string[] = [];
      const origError = console.error;
      console.error = (...args: unknown[]) => { errors.push(String(args[0])); };
      try {
        await (watcher as any).collect();
        await (watcher as any).refreshRules(clock.now());
      } finally {
        console.error = origError;
      }

      expect(errors.filter((m) => m.includes('bad-rule'))).toHaveLength(1);
    });
  });

  describe('rollup flush cadence and shadow logging', () => {
    it('runs baseline, rule-tick and shape-lane refresh cadences independent of frame arrival', async () => {
      const { clock, advance } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      const abortController = new AbortController();
      const streamConnector: StreamConnector = async function* () {
        // Simulates a live connection carrying only heartbeats/named events
        // (already filtered upstream by connectAgentSseStream): no data frames
        // until the caller aborts, at which point the generator ends.
        await new Promise<void>((resolve) => {
          abortController.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      } as unknown as StreamConnector;
      const watcher = makeWatcher(repos, streamConnector, abortController);

      const originalReconcile = (watcher as any).reconcile.bind(watcher);
      let resolveReconciled: () => void = () => {};
      const reconciled = new Promise<void>((resolve) => { resolveReconciled = resolve; });
      (watcher as any).reconcile = async (now: number) => {
        await originalReconcile(now);
        resolveReconciled();
      };

      const collectPromise = (watcher as any).collect();
      await reconciled;

      expect(watcher.stats().entities).toBe(1);

      advance(70_000);
      await watcher.tick(clock.now());
      expect(repos.listShapesCalls.filter((id) => id === `${HOST.name}/c1`).length).toBeGreaterThan(1);

      abortController.abort(new DOMException('shutdown', 'AbortError'));
      await collectPromise;
    });
  });

  describe('teardown', () => {
    it('flushes pending rollups and persists baselines on a clean stream end', async () => {
      const { clock } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      const watcher = makeWatcher(repos, fixedStream([makeLogFrame({ text: 'final line before close' })]));

      await (watcher as any).collect();

      expect(repos.occurrences.length).toBeGreaterThan(0);
      expect(repos.savedBaselines.length).toBeGreaterThan(0);
    });

    it('aborts cleanly mid-stream, still flushing what was pending', async () => {
      const { clock } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      const abortController = new AbortController();

      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const streamConnector: StreamConnector = async function* () {
        yield makeLogFrame({ text: 'first line' });
        await gate;
        yield makeLogFrame({ text: 'never processed' });
      } as unknown as StreamConnector;

      const watcher = makeWatcher(repos, streamConnector, abortController);

      let markProcessed: () => void = () => {};
      const processed = new Promise<void>((resolve) => { markProcessed = resolve; });
      const originalHandleFrame = (watcher as any).handleFrame.bind(watcher);
      (watcher as any).handleFrame = (frame: unknown) => {
        originalHandleFrame(frame);
        markProcessed();
      };

      const collectPromise = (watcher as any).collect();
      await processed;

      abortController.abort(new DOMException('shutdown', 'AbortError'));
      release();

      await collectPromise;

      expect(repos.occurrences.some((o) => o.entityId === `${HOST.name}/c1`)).toBe(true);
      expect(repos.savedBaselines.some((b) => b.entityId === `${HOST.name}/c1`)).toBe(true);
    });

    it('propagates a connection failure from the stream connector', async () => {
      const { clock } = makeClock(0);
      const repos = createFakeRepos(clock);
      const streamConnector: StreamConnector = async () => {
        throw new Error('Agent returned 401: Unauthorized');
      };
      const watcher = makeWatcher(repos, streamConnector);

      await expect((watcher as any).collect()).rejects.toThrow('Agent returned 401');
    });
  });

  describe('tick-triggered signals', () => {
    it('emits a triage signal from a warm baseline stderr burst', async () => {
      const { clock, advance } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      repos.rules.push(
        makeRuleRecord({
          id: 'stderr-burst',
          kind: 'threshold',
          lane: 'triage',
          hardSignal: false,
          matcher: { type: 'threshold', metric: 'stderrCount', comparison: 'zScore', value: 4, windowMs: 60_000 },
        }),
      );
      const watcher = makeWatcher(repos, fixedStream([]));
      await (watcher as any).collect();

      // Warm the baseline: enough real ticks (>= COLD_START_MIN_TICKS) to clear cold start.
      for (let i = 0; i < 190; i++) {
        advance(10_000);
        await watcher.tick(clock.now());
      }
      // isColdStart also requires elapsed wall time >= COLD_START_MS (2h) since warmStartedAt.
      advance(COLD_START_MS);
      await watcher.tick(clock.now());

      // A sudden stderr burst spread across the six baseline ticks making up one
      // 60s rule-tick window (dumping it all into a single baseline tick would let
      // that one tick's own EWMA update absorb most of the burst before evaluation).
      for (let tick = 0; tick < 6; tick++) {
        for (let i = 0; i < 5; i++) {
          (watcher as any).handleFrame(makeLogFrame({ text: `stderr burst ${tick}-${i}`, stream: 'stderr', at: null }));
        }
        advance(10_000);
        await watcher.tick(clock.now());
      }

      const tickSignal = repos.signals.find((s) => s.trigger === 'tick');
      expect(tickSignal).toBeDefined();
      expect(tickSignal?.lane).toBe('triage');
      expect(tickSignal?.metrics.baselineZ).not.toBeNull();

      // One more rule tick prunes the correlate ledger entry the burst just recorded.
      advance(60_000);
      await watcher.tick(clock.now());
    });
  });

  describe('shape lane refresh', () => {
    it('picks up an updated route from the repository within a few ticks, without touching a pinned overflow entry', async () => {
      const { clock, advance } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      const entityId = `${HOST.name}/c1`;
      const watcher = makeWatcher(repos, fixedStream([]));
      await (watcher as any).collect();

      const state = (watcher as any).entities.get(entityId);
      state.shapes.fine.set('shape-a', {
        entityId, shapeId: 'shape-a', template: 'foo', lane: 'batch', laneSource: 'default',
        firstSeenAt: 0, lastSeenAt: 0, buckets: new Map(), dirty: false,
      });
      state.shapes.overflow = {
        entityId, shapeId: 'overflow-id', template: '<OVERFLOW>', lane: 'count', laneSource: 'overflow',
        firstSeenAt: 0, lastSeenAt: 0, buckets: new Map(), dirty: false,
      };

      repos.shapesByEntity.set(entityId, [
        makeShapeRecord({ entityId, shapeId: 'shape-a', template: 'foo', lane: 'triage', laneSource: 'agent' }),
        makeShapeRecord({ entityId, shapeId: 'overflow-id', template: '<OVERFLOW>', lane: 'triage', laneSource: 'agent' }),
      ]);

      advance(10_000);
      await watcher.tick(clock.now());

      expect(state.shapes.fine.get('shape-a').lane).toBe('triage');
      expect(state.shapes.fine.get('shape-a').laneSource).toBe('agent');
      // Overflow stays pinned even though the repository returned a different lane for it.
      expect(state.shapes.overflow.lane).toBe('count');
      expect(state.shapes.overflow.laneSource).toBe('overflow');
    });
  });

  it('uses the injected stream connector with the expected path and signer', async () => {
    const { clock } = makeClock(0);
    const repos = createFakeRepos(clock);
    const connectSpy = mock(fixedStream([]));
    const watcher = makeWatcher(repos, connectSpy as unknown as StreamConnector);

    await (watcher as any).collect();

    expect(connectSpy).toHaveBeenCalledTimes(1);
    const callArgs = connectSpy.mock.calls[0][0] as { agentUrl: string; path: string };
    expect(callArgs.agentUrl).toBe(HOST.agentUrl);
    expect(callArgs.path).toBe('/logs/stream');
  });

  describe('dependency failures are logged and do not throw', () => {
    async function withSilencedConsole<T>(fn: () => Promise<T>): Promise<T> {
      const origError = console.error;
      const origWarn = console.warn;
      console.error = () => {};
      console.warn = () => {};
      try {
        return await fn();
      } finally {
        console.error = origError;
        console.warn = origWarn;
      }
    }

    it('a rule refresh failure leaves the previous compiled rules in place', async () => {
      const { clock } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      const watcher = makeWatcher(repos, fixedStream([]));
      await (watcher as any).collect();

      repos.failures.listEvaluableRules = true;
      await withSilencedConsole(() => (watcher as any).refreshRules(clock.now()));

      expect(repos.signals).toHaveLength(0);
    });

    it('a container snapshot failure aborts the reconcile without throwing', async () => {
      const { clock, advance } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      const watcher = makeWatcher(repos, fixedStream([]));
      await (watcher as any).collect();

      repos.failures.getCurrentSnapshot = true;
      advance(31_000);
      await withSilencedConsole(() => watcher.tick(clock.now()));

      // The previously admitted entity is untouched by the failed reconcile.
      expect(watcher.stats().entities).toBe(1);
    });

    it('an entity-metadata failure still admits the container, defaulting its tier', async () => {
      const { clock } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      repos.metadata.set(`${HOST.name}/c1`, new Map([['criticality', '0']]));
      repos.failures.getEntityMetadata = true;
      const watcher = makeWatcher(repos, fixedStream([]));

      await withSilencedConsole(() => (watcher as any).collect());

      expect(watcher.stats().entities).toBe(1);
      const state = (watcher as any).entities.get(`${HOST.name}/c1`);
      expect(state.ctx.tier).toBe(1);
    });

    it('a baseline loadMany failure still admits the container with a fresh baseline', async () => {
      const { clock } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      repos.failures.loadMany = true;
      const watcher = makeWatcher(repos, fixedStream([]));

      await withSilencedConsole(() => (watcher as any).collect());

      expect(watcher.stats().entities).toBe(1);
    });

    it('a baseline persistence failure at teardown does not throw', async () => {
      const { clock } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      repos.failures.saveMany = true;
      const watcher = makeWatcher(repos, fixedStream([]));

      await withSilencedConsole(() => (watcher as any).collect());

      expect(repos.savedBaselines).toHaveLength(0);
    });

    it('a shape-lane refresh failure is logged and does not disrupt other entities', async () => {
      const { clock, advance } = makeClock(1_000_000);
      const repos = createFakeRepos(clock);
      repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
      const watcher = makeWatcher(repos, fixedStream([]));
      await (watcher as any).collect();

      repos.failures.listShapes = true;
      advance(10_000);
      await withSilencedConsole(() => watcher.tick(clock.now()));

      expect(watcher.stats().entities).toBe(1);
    });
  });

  it('logs an aggregate summary of shadow rule fires on the shadow-log cadence', async () => {
    const { clock, advance } = makeClock(1_000_000);
    const repos = createFakeRepos(clock);
    repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
    repos.rules.push(
      makeRuleRecord({
        id: 'shadow-rule',
        lane: 'triage',
        state: 'shadow',
        matcher: { type: 'literal', needle: 'SHADOW_TRIGGER', caseSensitive: true, target: 'raw', stream: 'any' },
      }),
    );
    const watcher = makeWatcher(repos, fixedStream([]));
    await (watcher as any).collect();

    (watcher as any).handleFrame(makeLogFrame({ text: 'SHADOW_TRIGGER seen', at: null }));

    const infoMessages: string[] = [];
    const origInfo = console.info;
    console.info = (...args: unknown[]) => { infoMessages.push(String(args[0])); };
    try {
      advance(310_000);
      await watcher.tick(clock.now());
    } finally {
      console.info = origInfo;
    }

    expect(infoMessages.some((m) => m.includes('shadow rule fires') && m.includes('shadow-rule'))).toBe(true);
  });

  it('warns and truncates when more than four distinct silence windows are configured', async () => {
    const { clock } = makeClock(1_000_000);
    const repos = createFakeRepos(clock);
    repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
    for (const windowMs of [60_000, 120_000, 180_000, 240_000, 300_000]) {
      repos.rules.push(makeRuleRecord({ id: `silence-${windowMs}`, kind: 'silence', matcher: { type: 'silence', windowMs } }));
    }
    const watcher = makeWatcher(repos, fixedStream([]));

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
    try {
      await (watcher as any).collect();
    } finally {
      console.warn = origWarn;
    }

    expect((watcher as any).silenceWindows).toHaveLength(4);
    expect(warnings.some((m) => m.includes('distinct silence windows'))).toBe(true);
  });

  it('drives tick() from the real setInterval wiring', async () => {
    const { clock, advance } = makeClock(1_000_000);
    const repos = createFakeRepos(clock);
    repos.rows.push(makeUpsertRow({ containerId: 'c1' }));
    const abortController = new AbortController();
    const streamConnector: StreamConnector = async function* () {
      await new Promise<void>((resolve) => {
        abortController.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    } as unknown as StreamConnector;
    const watcher = makeWatcher(repos, streamConnector, abortController);

    let intervalCallback: (() => void) | undefined;
    let resolveIntervalSet: () => void = () => {};
    const intervalSet = new Promise<void>((resolve) => { resolveIntervalSet = resolve; });
    const setIntervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(
      ((fn: () => void) => {
        intervalCallback = fn;
        resolveIntervalSet();
        return 0;
      }) as unknown as typeof setInterval,
    );
    try {
      const collectPromise = (watcher as any).collect();
      await intervalSet;

      expect(intervalCallback).toBeDefined();
      advance(10_000);
      intervalCallback!();
      await Promise.resolve();
      await Promise.resolve();

      expect(watcher.stats().entities).toBe(1);

      abortController.abort(new DOMException('shutdown', 'AbortError'));
      await collectPromise;
    } finally {
      setIntervalSpy.mockRestore();
    }
  });
});
