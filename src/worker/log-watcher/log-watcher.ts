import { z } from 'zod';
import { BaseCollector } from '@/worker/collectors/base-collector';
import { connectAgentSseStream } from '@/worker/collectors/agent-sse-stream';
import {
  MAX_BUCKET_EXEMPLARS,
  MAX_BUCKET_NUMBERS,
  MAX_EXEMPLAR_LINE_CHARS,
} from '@/lib/database/repositories/log-shape-repository';
import type {
  LogShapeRecord,
  LogShapeExemplar,
  RecordShapeOccurrenceInput,
  RecordShapeBucketInput,
} from '@/lib/database/repositories/log-shape-repository';
import type { DetectorRuleRecord } from '@/lib/database/repositories/detector-rule-repository';
import type {
  DockerContainerEventRow,
  DockerContainerEventUpsertRow,
} from '@/lib/database/repositories/docker-container-event-repository';
import type { ContainerState } from '@/types/docker-inventory';
import { LANE_SEVERITY } from '@/lib/logs/types';
import type { LogLane, LogStream, Tier } from '@/lib/logs/types';
import { MAX_SHAPES_PER_ENTITY, coarsenTemplate, normalizeLogLine, shapeIdForTemplate } from '@/lib/logs/shape';
import type { NormalizedShape } from '@/lib/logs/shape';
import {
  createBaselineState,
  evaluateRate,
  evaluateSilence,
  isColdStart,
  observeTick,
  parseBaselineState,
  resetForImageChange,
  serializeBaselineState,
} from '@/lib/logs/baseline';
import type { BaselineState } from '@/lib/logs/baseline';
import { compileRules, evaluateCompiled } from '@/lib/logs/rules';
import type {
  CompiledRuleSet,
  ContainerStateEvent,
  DetectorRule,
  EventEvalContext,
  LaneDecision,
  LineEvalContext,
  RuleMatcher,
  RuleScope,
  TickEvalContext,
  WindowMetrics,
} from '@/lib/logs/rules';
import { resolveTier } from './tier';
import { systemClock } from './types';
import type { Clock, EntityContext, ExcerptLine, LogSignal, SignalEvent, SignalMetrics, SignalTrigger } from './types';

const BASELINE_TICK_MS = 10_000;
const RULE_TICK_MS = 60_000;
const ROLLUP_FLUSH_INTERVAL_MS = 10_000;
const INVENTORY_REFRESH_MS = 30_000;
const RULE_REFRESH_INTERVAL_MS = 60_000;
const BASELINE_PERSIST_INTERVAL_MS = 300_000;
const EXCERPT_RING_LINES = 60;
const EXCERPT_STDERR_RING_LINES = 20;
const EXCERPT_LINE_MAX_CHARS = 512;

const COARSE_RESERVE = 32;
const FINE_ADMIT_LIMIT = MAX_SHAPES_PER_ENTITY - COARSE_RESERVE;
const OVERFLOW_TEMPLATE = '<OVERFLOW>';
const COUNT_LANE_EXEMPLARS = 2;
const ROLLUP_FLUSH_MAX_DIRTY = 500;
const SHAPE_REFRESH_ENTITIES_PER_TICK = 4;
const SHADOW_LOG_INTERVAL_MS = 300_000;
const FOLD_LOG_INTERVAL_MS = 3_600_000;
const CORRELATE_RETENTION_MS = 600_000;
const CORRELATE_MAX_TIMESTAMPS_PER_RULE = 32;
const CORRELATE_MAX_RULES_PER_ENTITY = 64;
const RESTART_RING_WINDOW_MS = 600_000;
const MAX_SILENCE_WINDOWS = 4;

export interface LogWatcherHost {
  readonly name: string;
  readonly agentUrl: string;
}

export interface LogShapeRepository {
  listShapes(entityId: string, options?: { readonly lane?: LogLane; readonly limit?: number }): Promise<LogShapeRecord[]>;
  recordShapeOccurrence(input: RecordShapeOccurrenceInput): Promise<void>;
  recordShapeBucket(input: RecordShapeBucketInput): Promise<void>;
}

export interface DetectorRuleRepository {
  listEvaluableRules(): Promise<DetectorRuleRecord[]>;
}

export interface EntityMetadataRepository {
  getEntityMetadata(entities: readonly string[]): Promise<Map<string, Map<string, string>>>;
}

export interface DockerContainerEventRepository {
  getCurrentSnapshot(): Promise<DockerContainerEventRow[]>;
}

export interface LogBaselineRepository {
  loadMany(entityIds: readonly string[]): Promise<Map<string, string>>;
  saveMany(entries: readonly { readonly entityId: string; readonly state: string }[]): Promise<void>;
}

export interface LogWatcherDeps {
  readonly logShapeRepository: LogShapeRepository;
  readonly detectorRuleRepository: DetectorRuleRepository;
  readonly entityMetadataRepository: EntityMetadataRepository;
  readonly containerEventRepository: DockerContainerEventRepository;
  readonly baselineRepository: LogBaselineRepository;
  readonly onSignal: (signal: LogSignal) => void;
  readonly onRunningCountChange?: (running: number) => void;
  readonly clock?: Clock;
  readonly streamConnector?: typeof connectAgentSseStream;
}

export interface LogWatcherTuning {
  readonly baselineTickMs?: number;
  readonly ruleTickMs?: number;
  readonly rollupFlushIntervalMs?: number;
  readonly inventoryRefreshMs?: number;
  readonly ruleRefreshIntervalMs?: number;
  readonly baselinePersistIntervalMs?: number;
  readonly excerptRingLines?: number;
  readonly excerptStderrRingLines?: number;
}

interface ResolvedTuning {
  readonly baselineTickMs: number;
  readonly ruleTickMs: number;
  readonly rollupFlushIntervalMs: number;
  readonly inventoryRefreshMs: number;
  readonly ruleRefreshIntervalMs: number;
  readonly baselinePersistIntervalMs: number;
  readonly excerptRingLines: number;
  readonly excerptStderrRingLines: number;
}

const DEFAULT_TUNING: ResolvedTuning = {
  baselineTickMs: BASELINE_TICK_MS,
  ruleTickMs: RULE_TICK_MS,
  rollupFlushIntervalMs: ROLLUP_FLUSH_INTERVAL_MS,
  inventoryRefreshMs: INVENTORY_REFRESH_MS,
  ruleRefreshIntervalMs: RULE_REFRESH_INTERVAL_MS,
  baselinePersistIntervalMs: BASELINE_PERSIST_INTERVAL_MS,
  excerptRingLines: EXCERPT_RING_LINES,
  excerptStderrRingLines: EXCERPT_STDERR_RING_LINES,
};

export interface LogWatcherStats {
  readonly entities: number;
  readonly cachedShapes: number;
  readonly foldedEntities: number;
  readonly linesSeen: number;
  readonly linesDropped: number;
  readonly signalsEmitted: number;
}

interface FleetLogLineLike {
  readonly containerId: string;
  readonly containerName: string;
  readonly at: string | null;
  readonly stream: LogStream;
  readonly text: string;
}

function isFleetLogLine(value: unknown): value is FleetLogLineLike {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.containerId === 'string' &&
    typeof v.containerName === 'string' &&
    (v.at === null || typeof v.at === 'string') &&
    (v.stream === 'stdout' || v.stream === 'stderr') &&
    typeof v.text === 'string'
  );
}

interface ShapeBucketAccumulator {
  count: number;
  exemplars: LogShapeExemplar[];
  numbers: number[];
}

interface ShapeEntry {
  readonly entityId: string;
  readonly shapeId: string;
  readonly template: string;
  lane: LogLane;
  laneSource: string;
  firstSeenAt: number;
  lastSeenAt: number;
  readonly buckets: Map<number, ShapeBucketAccumulator>;
  dirty: boolean;
}

interface EntityShapes {
  readonly fine: Map<string, ShapeEntry>;
  readonly coarse: Map<string, ShapeEntry>;
  overflow: ShapeEntry | null;
}

interface EntityRuntimeState {
  ctx: EntityContext;
  baseline: BaselineState;
  imageChangedAt: number | null;
  lastKnownState: ContainerState;
  readonly shapes: EntityShapes;
  recent: ExcerptLine[];
  recentStderr: ExcerptLine[];
  tickLineCount: number;
  tickStderrCount: number;
  windowLineCount: number;
  windowStderrCount: number;
  windowShapeCounts: Map<string, number>;
  recentRuleMatches: Map<string, number[]>;
  restartTimestamps: number[];
  lastFoldLogAt: number;
}

function floorToHour(ms: number): number {
  return Math.floor(ms / 3_600_000) * 3_600_000;
}

function sumBucketCounts(entry: ShapeEntry): number {
  let total = 0;
  for (const bucket of entry.buckets.values()) total += bucket.count;
  return total;
}

const zRuleScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('entity'), entityId: z.string() }),
  z.object({ kind: z.literal('service'), serviceKey: z.string() }),
  z.object({ kind: z.literal('stack'), project: z.string() }),
  z.object({ kind: z.literal('host'), host: z.string() }),
  z.object({ kind: z.literal('fleet') }),
]);

const zStream = z.enum(['stdout', 'stderr', 'any']);
const zTarget = z.enum(['raw', 'template']);

const zRuleMatcher = z.discriminatedUnion('type', [
  z.object({ type: z.literal('literal'), needle: z.string(), caseSensitive: z.boolean(), target: zTarget, stream: zStream }),
  z.object({ type: z.literal('regex'), pattern: z.string(), flags: z.string(), target: zTarget, stream: zStream }),
  z.object({ type: z.literal('shape'), shapeIds: z.array(z.string()) }),
  z.object({
    type: z.literal('threshold'),
    metric: z.enum(['lineCount', 'stderrCount', 'stderrRatio', 'shapeCount']),
    comparison: z.enum(['absolute', 'baselineMultiple', 'zScore']),
    value: z.number(),
    windowMs: z.number(),
    shapeId: z.string().optional(),
    sinceImageChangeMaxMs: z.number().optional(),
  }),
  z.object({ type: z.literal('silence'), windowMs: z.number() }),
  z.object({
    type: z.literal('event'),
    eventTypes: z.array(z.string()),
    oomKilled: z.boolean().optional(),
    exitCodeNonZero: z.boolean().optional(),
    healthStatus: z.enum(['unhealthy', 'starting']).optional(),
    minRestartsInWindow: z.number().optional(),
    windowMs: z.number().optional(),
  }),
  z.object({ type: z.literal('correlate'), ruleIds: z.array(z.string()), windowMs: z.number() }),
]);

export class LogWatcher extends BaseCollector {
  readonly name: string;

  private readonly clock: Clock;
  private readonly streamConnector: typeof connectAgentSseStream;
  private readonly tuning: ResolvedTuning;

  private readonly entities = new Map<string, EntityRuntimeState>();
  private readonly dirtyEntries = new Set<ShapeEntry>();
  private readonly shadowCounts = new Map<string, number>();
  private readonly ruleNamesById = new Map<string, string>();
  private readonly loggedInvalidRuleIds = new Set<string>();

  private compiledRules: CompiledRuleSet = { rules: [], byTrigger: { line: [], tick: [], event: [] }, invalid: [] };
  private silenceWindows: readonly number[] = [];

  private lastRuleRefreshAt = 0;
  private lastReconcileAt = 0;
  private lastBaselineTickAt = 0;
  private lastRuleTickAt = 0;
  private lastRollupFlushAt = 0;
  private lastBaselinePersistAt = 0;
  private lastShadowLogAt = 0;

  private inventoryDirty = false;
  private roundRobinIndex = 0;

  private linesSeen = 0;
  private linesDroppedTotal = 0;
  private linesDroppedSinceReconcile = 0;
  private signalsEmitted = 0;

  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly host: LogWatcherHost,
    private readonly signer: () => Promise<string>,
    private readonly deps: LogWatcherDeps,
    parentAbortController?: AbortController,
    tuning: LogWatcherTuning = {},
  ) {
    super(undefined, undefined, parentAbortController);
    this.name = `LogWatcher[${host.name}]`;
    this.clock = deps.clock ?? systemClock;
    this.streamConnector = deps.streamConnector ?? connectAgentSseStream;
    this.tuning = { ...DEFAULT_TUNING, ...tuning };
  }

  protected async collect(): Promise<void> {
    const stream = await this.streamConnector({
      agentUrl: this.host.agentUrl,
      path: '/logs/stream',
      signer: this.signer,
      signal: this.signal,
    });
    this.resetBackoff();

    const now = this.clock.now();
    this.lastBaselineTickAt = now;
    this.lastRuleTickAt = now;
    this.lastRollupFlushAt = now;
    this.lastBaselinePersistAt = now;
    this.lastShadowLogAt = now;

    await this.refreshRules(now);
    await this.reconcile(now);

    const intervalMs = Math.min(this.tuning.baselineTickMs, this.tuning.rollupFlushIntervalMs);
    this.intervalHandle = setInterval(() => {
      void this.tick(this.clock.now());
    }, intervalMs);

    try {
      for await (const frame of stream) {
        if (this.signal.aborted) break;
        this.handleFrame(frame);
      }
    } finally {
      if (this.intervalHandle) {
        clearInterval(this.intervalHandle);
        this.intervalHandle = null;
      }
      const endNow = this.clock.now();
      await this.flushRollups(endNow);
      await this.persistBaselines(endNow);
    }
  }

  async tick(now: number): Promise<void> {
    if (now - this.lastRuleRefreshAt >= this.tuning.ruleRefreshIntervalMs) {
      await this.refreshRules(now);
    }
    if (this.inventoryDirty || now - this.lastReconcileAt >= this.tuning.inventoryRefreshMs) {
      await this.reconcile(now);
    }
    if (now - this.lastBaselineTickAt >= this.tuning.baselineTickMs) {
      this.runBaselineTick(now);
      this.lastBaselineTickAt = now;
    }
    if (now - this.lastRuleTickAt >= this.tuning.ruleTickMs) {
      this.runRuleTick(now);
      this.lastRuleTickAt = now;
    }
    await this.refreshShapeLanesRoundRobin();
    if (now - this.lastRollupFlushAt >= this.tuning.rollupFlushIntervalMs || this.dirtyEntries.size >= ROLLUP_FLUSH_MAX_DIRTY) {
      await this.flushRollups(now);
      this.lastRollupFlushAt = now;
    }
    if (now - this.lastBaselinePersistAt >= this.tuning.baselinePersistIntervalMs) {
      await this.persistBaselines(now);
      this.lastBaselinePersistAt = now;
    }
    if (now - this.lastShadowLogAt >= SHADOW_LOG_INTERVAL_MS) {
      this.flushShadowLog();
      this.lastShadowLogAt = now;
    }
  }

  stats(): LogWatcherStats {
    let cachedShapes = 0;
    let foldedEntities = 0;
    for (const state of this.entities.values()) {
      cachedShapes += state.shapes.fine.size + state.shapes.coarse.size + (state.shapes.overflow ? 1 : 0);
      if (state.shapes.coarse.size > 0 || state.shapes.overflow) foldedEntities++;
    }
    return {
      entities: this.entities.size,
      cachedShapes,
      foldedEntities,
      linesSeen: this.linesSeen,
      linesDropped: this.linesDroppedTotal,
      signalsEmitted: this.signalsEmitted,
    };
  }


  private handleFrame(frame: unknown): void {
    if (!isFleetLogLine(frame)) return;
    this.linesSeen++;

    const entityId = `${this.host.name}/${frame.containerId}`;
    const entity = this.entities.get(entityId);
    if (!entity) {
      this.linesDroppedTotal++;
      this.linesDroppedSinceReconcile++;
      this.inventoryDirty = true;
      return;
    }

    const now = this.clock.now();
    const parsedAt = frame.at ? Date.parse(frame.at) : NaN;
    const at = Number.isNaN(parsedAt) ? now : parsedAt;

    const shape = normalizeLogLine(frame.text);
    const entry = this.resolveShape(entityId, entity, shape, at, frame.stream, frame.text);

    this.pushExcerpt(entity, at, frame.stream, frame.text);
    entity.tickLineCount++;
    entity.windowLineCount++;
    if (frame.stream === 'stderr') {
      entity.tickStderrCount++;
      entity.windowStderrCount++;
    }
    entity.windowShapeCounts.set(shape.shapeId, (entity.windowShapeCounts.get(shape.shapeId) ?? 0) + 1);

    const lineCtx: LineEvalContext = {
      trigger: 'line',
      at,
      entityId,
      host: this.host.name,
      serviceKey: entity.ctx.serviceKey,
      stackProject: entity.ctx.stackProject,
      tier: entity.ctx.tier,
      coldStart: isColdStart(entity.baseline, at),
      sinceImageChangeMs: entity.imageChangedAt !== null ? at - entity.imageChangedAt : null,
      recentRuleMatches: entity.recentRuleMatches,
      line: frame.text,
      stream: frame.stream,
      shape,
    };
    const decision = evaluateCompiled(this.compiledRules, lineCtx);
    this.recordRuleMatches(entity, decision, at);
    this.recordShadow(decision);

    let lane: LogLane;
    let laneSource: string;
    if (decision.source === 'rule') {
      lane = decision.lane;
      laneSource = decision.decidingRuleId ?? 'rule';
    } else if (entry.laneSource !== 'default') {
      lane = entry.lane;
      laneSource = 'shape';
    } else {
      lane = decision.lane;
      laneSource = 'default';
    }
    this.setShapeLane(entry, lane, laneSource);

    if (lane === 'count' || lane === 'batch') return;

    const metrics: SignalMetrics = {
      windowMs: 0,
      lineCount: 1,
      stderrCount: frame.stream === 'stderr' ? 1 : 0,
      stderrRatio: frame.stream === 'stderr' ? 1 : 0,
      baselineExpected: null,
      baselineZ: null,
    };
    const signal = this.buildSignal({
      entityId,
      state: entity,
      at,
      decision,
      lane,
      trigger: 'line',
      shapeId: shape.shapeId,
      metrics,
      event: null,
      windowStart: at,
      windowEnd: at,
    });
    this.signalsEmitted++;
    this.deps.onSignal(signal);
  }


  private resolveShape(
    entityId: string,
    state: EntityRuntimeState,
    shape: NormalizedShape,
    at: number,
    stream: LogStream,
    text: string,
  ): ShapeEntry {
    const shapes = state.shapes;
    let entry = shapes.fine.get(shape.shapeId);

    if (!entry) {
      if (shapes.fine.size < FINE_ADMIT_LIMIT) {
        entry = this.createShapeEntry(entityId, shape.shapeId, shape.template, at);
        shapes.fine.set(shape.shapeId, entry);
      } else {
        this.logFoldIfDue(entityId, state, at);
        const coarseTemplate = coarsenTemplate(shape.template);
        const coarseId = shapeIdForTemplate(coarseTemplate);
        entry = shapes.coarse.get(coarseId);
        if (!entry) {
          if (shapes.fine.size + shapes.coarse.size < MAX_SHAPES_PER_ENTITY) {
            entry = this.createShapeEntry(entityId, coarseId, coarseTemplate, at);
            shapes.coarse.set(coarseId, entry);
          } else {
            if (!shapes.overflow) {
              shapes.overflow = this.createShapeEntry(entityId, shapeIdForTemplate(OVERFLOW_TEMPLATE), OVERFLOW_TEMPLATE, at);
              shapes.overflow.lane = 'count';
              shapes.overflow.laneSource = 'overflow';
            }
            entry = shapes.overflow;
          }
        }
      }
    }

    this.addLineToEntry(entry, at, stream, text, shape.numbers);
    return entry;
  }

  private createShapeEntry(entityId: string, shapeId: string, template: string, at: number): ShapeEntry {
    return {
      entityId,
      shapeId,
      template,
      lane: 'batch',
      laneSource: 'default',
      firstSeenAt: at,
      lastSeenAt: at,
      buckets: new Map(),
      dirty: false,
    };
  }

  private addLineToEntry(entry: ShapeEntry, at: number, stream: LogStream, text: string, numbers: readonly number[]): void {
    entry.lastSeenAt = Math.max(entry.lastSeenAt, at);
    entry.dirty = true;
    this.dirtyEntries.add(entry);

    const bucketStart = floorToHour(at);
    let bucket = entry.buckets.get(bucketStart);
    if (!bucket) {
      bucket = { count: 0, exemplars: [], numbers: [] };
      entry.buckets.set(bucketStart, bucket);
    }
    bucket.count += 1;

    const exemplarCap = entry.lane === 'count' ? COUNT_LANE_EXEMPLARS : MAX_BUCKET_EXEMPLARS;
    if (bucket.exemplars.length < exemplarCap) {
      const line = text.length > MAX_EXEMPLAR_LINE_CHARS ? text.slice(0, MAX_EXEMPLAR_LINE_CHARS) : text;
      bucket.exemplars.push({ at: new Date(at).toISOString(), stream, line });
    }
    if (entry.lane !== 'count') {
      for (const n of numbers) {
        if (bucket.numbers.length >= MAX_BUCKET_NUMBERS) break;
        bucket.numbers.push(n);
      }
    }
  }

  private setShapeLane(entry: ShapeEntry, lane: LogLane, laneSource: string): void {
    if (entry.laneSource === 'overflow') return;
    if (entry.lane === lane && entry.laneSource === laneSource) return;
    entry.lane = lane;
    entry.laneSource = laneSource;
  }

  private logFoldIfDue(entityId: string, state: EntityRuntimeState, now: number): void {
    if (now - state.lastFoldLogAt < FOLD_LOG_INTERVAL_MS) return;
    state.lastFoldLogAt = now;
    console.info(
      `[${this.name}] ${entityId} exceeded shape budget (fine=${state.shapes.fine.size} coarse=${state.shapes.coarse.size}), folding new shapes`,
    );
  }

  private async flushOneEntry(entry: ShapeEntry): Promise<void> {
    const count = sumBucketCounts(entry);
    await this.deps.logShapeRepository.recordShapeOccurrence({
      entityId: entry.entityId,
      shapeId: entry.shapeId,
      template: entry.template,
      at: new Date(entry.lastSeenAt),
      count,
      lane: entry.lane,
      laneSource: entry.laneSource,
    });
    for (const [bucketStart, bucket] of entry.buckets) {
      await this.deps.logShapeRepository.recordShapeBucket({
        entityId: entry.entityId,
        shapeId: entry.shapeId,
        bucketStart: new Date(bucketStart),
        lane: entry.lane,
        count: bucket.count,
        exemplars: bucket.exemplars,
        numbers: bucket.numbers,
      });
    }
  }

  private async flushRollups(now: number): Promise<void> {
    void now;
    if (this.dirtyEntries.size === 0) return;
    const entries = [...this.dirtyEntries].filter((e) => sumBucketCounts(e) > 0);
    if (entries.length === 0) {
      this.dirtyEntries.clear();
      return;
    }

    const results = await Promise.allSettled(entries.map((e) => this.flushOneEntry(e)));
    let failed = 0;
    results.forEach((result, i) => {
      const entry = entries[i];
      if (result.status === 'fulfilled') {
        entry.buckets.clear();
        entry.dirty = false;
        this.dirtyEntries.delete(entry);
      } else {
        failed++;
      }
    });
    if (failed > 0) {
      console.error(`[${this.name}] rollup flush failed for ${failed} shape(s), retrying next flush`);
    }
  }

  private async refreshShapeLanesRoundRobin(): Promise<void> {
    const ids = [...this.entities.keys()];
    if (ids.length === 0) return;
    const batchSize = Math.min(SHAPE_REFRESH_ENTITIES_PER_TICK, ids.length);
    const batch: string[] = [];
    for (let i = 0; i < batchSize; i++) {
      batch.push(ids[this.roundRobinIndex % ids.length]);
      this.roundRobinIndex++;
    }
    await Promise.all(batch.map((id) => this.refreshEntityShapeLanes(id)));
  }

  private async refreshEntityShapeLanes(entityId: string): Promise<void> {
    const state = this.entities.get(entityId);
    if (!state) return;
    try {
      const records = await this.deps.logShapeRepository.listShapes(entityId, { limit: MAX_SHAPES_PER_ENTITY });
      for (const record of records) {
        const entry = this.lookupHydratedEntry(state.shapes, record);
        if (entry && entry.laneSource !== 'overflow') {
          entry.lane = record.lane;
          entry.laneSource = record.laneSource;
        }
      }
    } catch (err) {
      console.error(`[${this.name}] failed to refresh shape lanes for ${entityId}: ${String(err)}`);
    }
  }

  private lookupHydratedEntry(shapes: EntityShapes, record: LogShapeRecord): ShapeEntry | undefined {
    if (record.template === OVERFLOW_TEMPLATE) return shapes.overflow ?? undefined;
    if (record.template.startsWith('~')) return shapes.coarse.get(record.shapeId);
    return shapes.fine.get(record.shapeId);
  }


  private runBaselineTick(now: number): void {
    for (const state of this.entities.values()) {
      state.baseline = observeTick(state.baseline, { at: now, lineCount: state.tickLineCount, stderrCount: state.tickStderrCount });
      state.tickLineCount = 0;
      state.tickStderrCount = 0;
    }
  }

  private runRuleTick(now: number): void {
    const windows: readonly (number | null)[] = this.silenceWindows.length > 0 ? this.silenceWindows : [null];

    for (const [entityId, state] of this.entities) {
      this.pruneRuleMatches(state, now);

      const stderrRatio = state.windowLineCount > 0 ? state.windowStderrCount / state.windowLineCount : 0;
      const verdictLines = evaluateRate(state.baseline, {
        metric: 'lines',
        at: now,
        windowMs: this.tuning.ruleTickMs,
        observedCount: state.windowLineCount,
      });
      const verdictStderr = evaluateRate(state.baseline, {
        metric: 'stderr',
        at: now,
        windowMs: this.tuning.ruleTickMs,
        observedCount: state.windowStderrCount,
        observedLineCount: state.windowLineCount,
      });
      const verdictRatio = evaluateRate(state.baseline, {
        metric: 'stderrRatio',
        at: now,
        windowMs: this.tuning.ruleTickMs,
        observedCount: state.windowStderrCount,
        observedLineCount: state.windowLineCount,
      });

      let bestDecision: LaneDecision | null = null;
      let bestMetrics: WindowMetrics | null = null;

      for (const w of windows) {
        const silence = w === null ? null : evaluateSilence(state.baseline, { at: now, windowMs: w });
        const metrics: WindowMetrics = {
          windowMs: this.tuning.ruleTickMs,
          lineCount: state.windowLineCount,
          stderrCount: state.windowStderrCount,
          stderrRatio,
          shapeCounts: state.windowShapeCounts,
          lastNonEmptyAgoMs: now - state.baseline.lastNonEmptyTickAt,
          verdicts: { lines: verdictLines, stderr: verdictStderr, stderrRatio: verdictRatio },
          silence,
        };
        const ctx: TickEvalContext = {
          trigger: 'tick',
          at: now,
          entityId,
          host: this.host.name,
          serviceKey: state.ctx.serviceKey,
          stackProject: state.ctx.stackProject,
          tier: state.ctx.tier,
          coldStart: isColdStart(state.baseline, now),
          sinceImageChangeMs: state.imageChangedAt !== null ? now - state.imageChangedAt : null,
          recentRuleMatches: state.recentRuleMatches,
          metrics,
        };
        const decision = evaluateCompiled(this.compiledRules, ctx);
        this.recordRuleMatches(state, decision, now);
        if (!bestDecision || LANE_SEVERITY[decision.lane] > LANE_SEVERITY[bestDecision.lane]) {
          bestDecision = decision;
          bestMetrics = metrics;
        }
      }

      if (bestDecision) this.recordShadow(bestDecision);

      state.windowLineCount = 0;
      state.windowStderrCount = 0;
      state.windowShapeCounts = new Map();

      if (!bestDecision || !bestMetrics || bestDecision.source !== 'rule') continue;
      const lane = bestDecision.lane;
      if (lane === 'count' || lane === 'batch') continue;

      const deciding = bestDecision.matches[0] ?? null;
      const metrics: SignalMetrics = {
        windowMs: this.tuning.ruleTickMs,
        lineCount: bestMetrics.lineCount,
        stderrCount: bestMetrics.stderrCount,
        stderrRatio: bestMetrics.lineCount > 0 ? bestMetrics.stderrRatio : null,
        baselineExpected: deciding?.evidence.expected ?? null,
        baselineZ: deciding?.evidence.z ?? null,
      };
      const signal = this.buildSignal({
        entityId,
        state,
        at: now,
        decision: bestDecision,
        lane,
        trigger: 'tick',
        shapeId: null,
        metrics,
        event: null,
        windowStart: now - this.tuning.ruleTickMs,
        windowEnd: now,
      });
      this.signalsEmitted++;
      this.deps.onSignal(signal);
    }
  }

  private pruneRuleMatches(state: EntityRuntimeState, now: number): void {
    for (const [ruleId, timestamps] of state.recentRuleMatches) {
      const kept = timestamps.filter((t) => now - t <= CORRELATE_RETENTION_MS);
      if (kept.length === 0) state.recentRuleMatches.delete(ruleId);
      else if (kept.length !== timestamps.length) state.recentRuleMatches.set(ruleId, kept);
    }
  }

  private recordRuleMatches(state: EntityRuntimeState, decision: LaneDecision, now: number): void {
    for (const match of decision.matches) {
      let timestamps = state.recentRuleMatches.get(match.ruleId);
      if (!timestamps) {
        if (state.recentRuleMatches.size >= CORRELATE_MAX_RULES_PER_ENTITY) continue;
        timestamps = [];
        state.recentRuleMatches.set(match.ruleId, timestamps);
      }
      timestamps.push(now);
      if (timestamps.length > CORRELATE_MAX_TIMESTAMPS_PER_RULE) {
        timestamps.splice(0, timestamps.length - CORRELATE_MAX_TIMESTAMPS_PER_RULE);
      }
    }
  }

  private recordShadow(decision: LaneDecision): void {
    for (const s of decision.shadow) {
      this.shadowCounts.set(s.ruleId, (this.shadowCounts.get(s.ruleId) ?? 0) + 1);
    }
  }

  private flushShadowLog(): void {
    if (this.shadowCounts.size === 0) return;
    const summary = [...this.shadowCounts.entries()].map(([id, count]) => `${id}=${count}`).join(', ');
    console.info(`[${this.name}] shadow rule fires: ${summary}`);
    this.shadowCounts.clear();
  }


  private toDetectorRule(record: DetectorRuleRecord): DetectorRule | null {
    const matcherResult = zRuleMatcher.safeParse(record.matcher);
    const scopeResult = zRuleScope.safeParse(record.scope);
    if (!matcherResult.success || !scopeResult.success) {
      if (!this.loggedInvalidRuleIds.has(record.id)) {
        this.loggedInvalidRuleIds.add(record.id);
        console.error(`[${this.name}] rule ${record.id} has a malformed matcher or scope, skipping`);
      }
      return null;
    }
    return {
      id: record.id,
      version: record.version,
      name: record.name,
      kind: record.kind,
      matcher: matcherResult.data as RuleMatcher,
      lane: record.lane,
      state: record.state,
      enabled: record.enabled,
      scope: scopeResult.data as RuleScope,
      appliesToTiers: record.appliesToTiers,
      priority: record.priority,
      hardSignal: record.hardSignal,
      operatorApproved: record.operatorApproved,
      canaryUntil: record.canaryUntil,
      cooldownMs: record.cooldownMs,
      provenance: record.provenance,
    };
  }

  private async refreshRules(now: number): Promise<void> {
    this.lastRuleRefreshAt = now;
    let records: DetectorRuleRecord[];
    try {
      records = await this.deps.detectorRuleRepository.listEvaluableRules();
    } catch (err) {
      console.error(`[${this.name}] failed to refresh rules: ${String(err)}`);
      return;
    }

    const mapped: DetectorRule[] = [];
    this.ruleNamesById.clear();
    for (const record of records) {
      const rule = this.toDetectorRule(record);
      if (!rule) continue;
      mapped.push(rule);
      this.ruleNamesById.set(rule.id, rule.name);
    }

    const compiled = compileRules(mapped);
    if (compiled.invalid.length > 0) {
      console.error(
        `[${this.name}] ${compiled.invalid.length} rule(s) failed to compile: ${compiled.invalid
          .map((i) => `${i.ruleId}: ${i.error}`)
          .join('; ')}`,
      );
    }
    this.compiledRules = compiled;

    const windows = new Set<number>();
    for (const rule of mapped) {
      if (rule.matcher.type === 'silence') windows.add(rule.matcher.windowMs);
    }
    const sorted = [...windows].sort((a, b) => a - b);
    if (sorted.length > MAX_SILENCE_WINDOWS) {
      console.warn(
        `[${this.name}] ${sorted.length} distinct silence windows configured, only evaluating the first ${MAX_SILENCE_WINDOWS}`,
      );
    }
    this.silenceWindows = sorted.slice(0, MAX_SILENCE_WINDOWS);
  }


  private async reconcile(now: number): Promise<void> {
    this.lastReconcileAt = now;
    this.inventoryDirty = false;

    let rows: DockerContainerEventRow[];
    try {
      rows = await this.deps.containerEventRepository.getCurrentSnapshot();
    } catch (err) {
      console.error(`[${this.name}] reconcile: failed to load container snapshot: ${String(err)}`);
      return;
    }

    const upserts: DockerContainerEventUpsertRow[] = [];
    for (const row of rows) {
      if (row.eventType === 'upsert' && row.host === this.host.name) upserts.push(row);
    }
    const byEntity = new Map<string, DockerContainerEventUpsertRow>(upserts.map((r) => [`${this.host.name}/${r.containerId}`, r]));

    let metadata: Map<string, Map<string, string>>;
    try {
      metadata = await this.deps.entityMetadataRepository.getEntityMetadata([...byEntity.keys()]);
    } catch (err) {
      console.error(`[${this.name}] reconcile: failed to load entity metadata: ${String(err)}`);
      metadata = new Map();
    }

    const newEntityIds: string[] = [];
    for (const [entityId, row] of byEntity) {
      if (row.state === 'running' && !this.entities.has(entityId)) newEntityIds.push(entityId);
    }

    let baselineRows = new Map<string, string>();
    if (newEntityIds.length > 0) {
      try {
        baselineRows = await this.deps.baselineRepository.loadMany(newEntityIds);
      } catch (err) {
        console.error(`[${this.name}] reconcile: failed to load baselines: ${String(err)}`);
      }
    }

    for (const [entityId, row] of byEntity) {
      const tier = resolveTier(metadata.get(entityId));
      const running = row.state === 'running';
      const existing = this.entities.get(entityId);

      if (!existing) {
        if (!running) continue;
        await this.admitEntity(entityId, row, tier, now, baselineRows.get(entityId));
        continue;
      }

      if (existing.ctx.image !== row.image) {
        existing.baseline = resetForImageChange(existing.baseline, now, row.image);
        existing.imageChangedAt = now;
      }

      if (existing.lastKnownState !== row.state) {
        this.handleStateTransition(entityId, existing, existing.lastKnownState, row.state, row, now);
        existing.lastKnownState = row.state;
      }

      existing.ctx = {
        ...existing.ctx,
        image: row.image,
        stackProject: row.composeProject,
        serviceKey: row.serviceKey,
        tier,
        running,
      };

      if (!running) {
        await this.dropEntity(entityId, existing, now);
      }
    }

    for (const [entityId, state] of [...this.entities]) {
      if (!byEntity.has(entityId)) {
        await this.dropEntity(entityId, state, now);
      }
    }

    if (this.linesDroppedSinceReconcile > 0) {
      console.info(`[${this.name}] dropped ${this.linesDroppedSinceReconcile} log line(s) for unknown entities since last reconcile`);
      this.linesDroppedSinceReconcile = 0;
    }

    this.deps.onRunningCountChange?.(this.entities.size);
  }

  private async admitEntity(
    entityId: string,
    row: DockerContainerEventUpsertRow,
    tier: Tier,
    now: number,
    baselineRaw: string | undefined,
  ): Promise<void> {
    const baseline = baselineRaw !== undefined ? parseBaselineState(baselineRaw, entityId, now) : createBaselineState(entityId, now, row.image);

    const shapes: EntityShapes = { fine: new Map(), coarse: new Map(), overflow: null };
    try {
      const records = await this.deps.logShapeRepository.listShapes(entityId, { limit: MAX_SHAPES_PER_ENTITY });
      for (const record of records) {
        const entry: ShapeEntry = {
          entityId,
          shapeId: record.shapeId,
          template: record.template,
          lane: record.lane,
          laneSource: record.laneSource,
          firstSeenAt: record.firstSeenAt.getTime(),
          lastSeenAt: record.lastSeenAt.getTime(),
          buckets: new Map(),
          dirty: false,
        };
        if (record.template === OVERFLOW_TEMPLATE) shapes.overflow = entry;
        else if (record.template.startsWith('~')) shapes.coarse.set(record.shapeId, entry);
        else shapes.fine.set(record.shapeId, entry);
      }
    } catch (err) {
      console.error(`[${this.name}] reconcile: failed to hydrate shapes for ${entityId}: ${String(err)}`);
    }

    const ctx: EntityContext = {
      entityId,
      host: this.host.name,
      containerId: row.containerId,
      containerName: row.name,
      image: row.image,
      stackProject: row.composeProject,
      serviceKey: row.serviceKey,
      tier,
      running: true,
    };

    this.entities.set(entityId, {
      ctx,
      baseline,
      imageChangedAt: null,
      lastKnownState: row.state,
      shapes,
      recent: [],
      recentStderr: [],
      tickLineCount: 0,
      tickStderrCount: 0,
      windowLineCount: 0,
      windowStderrCount: 0,
      windowShapeCounts: new Map(),
      recentRuleMatches: new Map(),
      restartTimestamps: [],
      lastFoldLogAt: 0,
    });
  }

  private async dropEntity(entityId: string, state: EntityRuntimeState, now: number): Promise<void> {
    this.entities.delete(entityId);
    await this.flushRollups(now);
    try {
      await this.deps.baselineRepository.saveMany([{ entityId, state: serializeBaselineState(state.baseline) }]);
    } catch (err) {
      console.error(`[${this.name}] failed to persist baseline for ${entityId} on drop: ${String(err)}`);
    }
  }

  private handleStateTransition(
    entityId: string,
    state: EntityRuntimeState,
    prevState: ContainerState,
    newState: ContainerState,
    row: DockerContainerEventUpsertRow,
    now: number,
  ): void {
    void prevState;
    state.restartTimestamps = state.restartTimestamps.filter((t) => now - t <= RESTART_RING_WINDOW_MS);

    let ctxEvent: ContainerStateEvent | null = null;
    if (newState === 'exited' || newState === 'dead') {
      ctxEvent = {
        eventType: 'die',
        state: newState,
        exitCode: row.exitCode,
        oomKilled: false,
        healthStatus: null,
        restartsInWindow: state.restartTimestamps.length,
        windowMs: RESTART_RING_WINDOW_MS,
      };
    } else if (newState === 'running' && prevState !== 'running') {
      state.restartTimestamps.push(now);
      ctxEvent = {
        eventType: 'start',
        state: newState,
        exitCode: null,
        oomKilled: false,
        healthStatus: null,
        restartsInWindow: state.restartTimestamps.length,
        windowMs: RESTART_RING_WINDOW_MS,
      };
    }
    if (!ctxEvent) return;

    const ctx: EventEvalContext = {
      trigger: 'event',
      at: now,
      entityId,
      host: this.host.name,
      serviceKey: state.ctx.serviceKey,
      stackProject: state.ctx.stackProject,
      tier: state.ctx.tier,
      coldStart: isColdStart(state.baseline, now),
      sinceImageChangeMs: state.imageChangedAt !== null ? now - state.imageChangedAt : null,
      recentRuleMatches: state.recentRuleMatches,
      event: ctxEvent,
    };
    const decision = evaluateCompiled(this.compiledRules, ctx);
    this.recordRuleMatches(state, decision, now);
    this.recordShadow(decision);

    if (decision.source !== 'rule') return;
    const lane = decision.lane;
    if (lane === 'count' || lane === 'batch') return;

    const metrics: SignalMetrics = {
      windowMs: ctxEvent.windowMs,
      lineCount: 0,
      stderrCount: 0,
      stderrRatio: null,
      baselineExpected: null,
      baselineZ: null,
    };
    const event: SignalEvent = {
      eventType: ctxEvent.eventType,
      state: ctxEvent.state,
      exitCode: ctxEvent.exitCode,
      oomKilled: ctxEvent.oomKilled,
      healthStatus: ctxEvent.healthStatus,
      restartsInWindow: ctxEvent.restartsInWindow,
    };
    const signal = this.buildSignal({
      entityId,
      state,
      at: now,
      decision,
      lane,
      trigger: 'event',
      shapeId: null,
      metrics,
      event,
      windowStart: now,
      windowEnd: now,
    });
    this.signalsEmitted++;
    this.deps.onSignal(signal);
  }


  private pushExcerpt(state: EntityRuntimeState, at: number, stream: LogStream, text: string): void {
    const capped = text.length > EXCERPT_LINE_MAX_CHARS ? text.slice(0, EXCERPT_LINE_MAX_CHARS) : text;
    const line: ExcerptLine = { at, stream, text: capped };
    state.recent.push(line);
    if (state.recent.length > this.tuning.excerptRingLines) state.recent.shift();
    if (stream === 'stderr') {
      state.recentStderr.push(line);
      if (state.recentStderr.length > this.tuning.excerptStderrRingLines) state.recentStderr.shift();
    }
  }

  private collectExcerpt(state: EntityRuntimeState): ExcerptLine[] {
    const map = new Map<string, ExcerptLine>();
    for (const l of state.recent) map.set(`${l.at} ${l.stream} ${l.text}`, l);
    for (const l of state.recentStderr) map.set(`${l.at} ${l.stream} ${l.text}`, l);
    return [...map.values()].sort((a, b) => a.at - b.at);
  }

  private buildSignal(params: {
    entityId: string;
    state: EntityRuntimeState;
    at: number;
    decision: LaneDecision;
    lane: Extract<LogLane, 'page' | 'triage'>;
    trigger: SignalTrigger;
    shapeId: string | null;
    metrics: SignalMetrics;
    event: SignalEvent | null;
    windowStart: number;
    windowEnd: number;
  }): LogSignal {
    const { entityId, state, at, decision, lane, trigger, shapeId, metrics, event, windowStart, windowEnd } = params;
    const matches = decision.matches;
    return {
      at,
      entityId,
      host: this.host.name,
      containerName: state.ctx.containerName,
      image: state.ctx.image,
      stackProject: state.ctx.stackProject,
      serviceKey: state.ctx.serviceKey,
      tier: state.ctx.tier,
      lane,
      trigger,
      decidingRuleId: decision.decidingRuleId,
      ruleIds: matches.map((m) => m.ruleId),
      ruleNames: matches.map((m) => this.ruleNamesById.get(m.ruleId) ?? ''),
      shapeId,
      hardSignal: matches.some((m) => m.hardSignal),
      coldStart: isColdStart(state.baseline, at),
      sinceImageChangeMs: state.imageChangedAt !== null ? at - state.imageChangedAt : null,
      windowStart,
      windowEnd,
      metrics,
      event,
      excerptLines: this.collectExcerpt(state),
    };
  }


  private async persistBaselines(now: number): Promise<void> {
    void now;
    if (this.entities.size === 0) return;
    const entries = [...this.entities.entries()].map(([entityId, state]) => ({
      entityId,
      state: serializeBaselineState(state.baseline),
    }));
    try {
      await this.deps.baselineRepository.saveMany(entries);
    } catch (err) {
      console.error(`[${this.name}] failed to persist baselines: ${String(err)}`);
    }
  }
}
