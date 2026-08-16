import { createHmac } from 'node:crypto';
import PQueue from 'p-queue';
import { LANE_SEVERITY } from '@/lib/logs/types';
import { backoffDelayMs } from '@/lib/utils/backoff';
import { abortableSleep } from '@/lib/utils/abortable-sleep';
import { IncidentCoalescer } from './incident';
import { systemClock } from './types';
import type { Clock, ExcerptLine, Incident, LogSignal, SignalEvent, Tier } from './types';
import { deriveCapacity, policyFor, routeFor, PAGE_ROUTE } from './tier';
import type { DerivedCapacity, HermesCeilings } from './tier';

type PolicyTier = Tier;

export const EXCERPT_MAX_BYTES = 4096;
export const EXCERPT_LINE_MAX_CHARS = 512;
export const PAYLOAD_MAX_BYTES = 262_144;

export const HERMES_PAYLOAD_FIELDS: readonly string[] = Object.freeze(
  [
    'at',
    'baselineExpected',
    'baselineZ',
    'coldStart',
    'container',
    'containers',
    'dashboardUrl',
    'digest',
    'entities',
    'entityCount',
    'entityId',
    'eventType',
    'excerpt',
    'exitCode',
    'healthy',
    'host',
    'image',
    'incidentId',
    'lane',
    'lineCount',
    'mergedFrom',
    'occurrence',
    'oomKilled',
    'restartsInWindow',
    'route',
    'ruleIds',
    'ruleNames',
    'scope',
    'service',
    'severity',
    'shapeIds',
    'signalCount',
    'sinceImageChangeMs',
    'stack',
    'stderrCount',
    'stderrRatio',
    'tier',
    'title',
    'version',
    'windowEnd',
    'windowStart',
  ].sort(),
);

const JOIN_LIST_CAP = 20;
const TITLE_MAX_CHARS = 200;
const MAX_QUEUED_PER_LANE = 100;
const PAGE_CONCURRENCY = 4;
const HTTP_TIMEOUT_MS = 5_000;
const MAX_DELIVERY_MS = 15_000;
const MAX_ATTEMPTS = 3;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_OPEN_MS = 60_000;
const RETRY_AFTER_MAX_MS = 30_000;
const DISPATCH_TICK_MS = 1_000;
const CONFIG_TTL_MS = 30_000;

const REJECTED_STATUSES = new Set([400, 401, 403, 413, 422]);

export type HermesPayload = Readonly<Record<string, string | number>>;

export interface BuildPayloadInput {
  readonly incident: Incident;
  readonly occurrence: number;
  readonly lane: 'page' | 'triage';
  readonly route: string;
  readonly at: number;
  readonly digest?: string;
  readonly dashboardBaseUrl?: string;
}

export class PayloadTooLargeError extends Error {
  constructor(
    readonly byteLength: number,
    readonly incidentId: string,
  ) {
    super(`Hermes payload for incident ${incidentId} is ${byteLength} bytes, exceeding ${PAYLOAD_MAX_BYTES}`);
    this.name = 'PayloadTooLargeError';
  }
}

function isoString(ms: number): string {
  return new Date(ms).toISOString();
}

function yesNo(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  return value ? 'yes' : 'no';
}

function joinCapped(items: readonly string[], cap: number = JOIN_LIST_CAP): string {
  if (items.length <= cap) return items.join(',');
  return `${items.slice(0, cap).join(',')},+${items.length - cap} more`;
}

function primarySignal(incident: Incident): LogSignal | null {
  if (incident.signals.length === 0) return null;
  const matching = incident.signals.filter((s) => s.entityId === incident.primaryEntityId);
  const pool = matching.length > 0 ? matching : incident.signals;
  return pool.reduce((latest, s) => (s.at >= latest.at ? s : latest), pool[0]);
}

function aggregateLineCounts(incident: Incident): { lineCount: number; stderrCount: number } {
  let lineCount = 0;
  let stderrCount = 0;
  for (const s of incident.signals) {
    lineCount += s.metrics.lineCount;
    stderrCount += s.metrics.stderrCount;
  }
  return { lineCount, stderrCount };
}

function containerNamesFor(incident: Incident): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const s of incident.signals) {
    if (!seen.has(s.entityId)) {
      seen.add(s.entityId);
      names.push(s.containerName);
    }
  }
  return names;
}

function aggregateRules(
  incident: Incident,
  primary: LogSignal | null,
): { ruleIds: string[]; ruleNames: string[] } {
  const ids: string[] = [];
  const names: string[] = [];
  const seen = new Set<string>();
  const pushFrom = (signal: LogSignal) => {
    signal.ruleIds.forEach((id, i) => {
      if (seen.has(id)) return;
      seen.add(id);
      ids.push(id);
      names.push(signal.ruleNames[i] ?? '');
    });
  };
  if (primary) pushFrom(primary);
  for (const s of incident.signals) {
    if (s !== primary) pushFrom(s);
  }
  return { ruleIds: ids, ruleNames: names };
}

function aggregateShapeIds(incident: Incident): string[] {
  const seen = new Set<string>();
  for (const s of incident.signals) {
    if (s.shapeId) seen.add(s.shapeId);
  }
  return [...seen];
}

function aggregateExcerptLines(incident: Incident): ExcerptLine[] {
  const map = new Map<string, ExcerptLine>();
  for (const s of incident.signals) {
    for (const line of s.excerptLines) {
      map.set(`${line.at}${line.stream}${line.text}`, line);
    }
  }
  return [...map.values()].sort((a, b) => a.at - b.at);
}

function renderExcerptLine(line: ExcerptLine): string {
  const time = `${new Date(line.at).toISOString().slice(11, 19)}Z`;
  const text = line.text.length > EXCERPT_LINE_MAX_CHARS ? line.text.slice(0, EXCERPT_LINE_MAX_CHARS) : line.text;
  return `${time} ${line.stream} ${text}`;
}

function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString('utf8').replace(/�+$/u, '');
}

export function renderExcerpt(lines: readonly ExcerptLine[], maxBytes: number = EXCERPT_MAX_BYTES): string {
  if (lines.length === 0) return '';
  const rendered = lines.map(renderExcerptLine);
  const full = rendered.join('\n');
  if (Buffer.byteLength(full, 'utf8') <= maxBytes) return full;

  let keptFromIndex = rendered.length;
  let bytes = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const lineBytes = Buffer.byteLength(rendered[i], 'utf8') + 1;
    const suffix = `\n…[truncated ${i} of ${rendered.length} lines]`;
    const suffixBytes = Buffer.byteLength(suffix, 'utf8');
    if (bytes + lineBytes + suffixBytes > maxBytes) break;
    bytes += lineBytes;
    keptFromIndex = i;
  }
  const dropped = keptFromIndex;
  const kept = rendered.slice(keptFromIndex);
  if (kept.length === 0) {
    return truncateUtf8(`…[truncated ${rendered.length} of ${rendered.length} lines]`, maxBytes);
  }
  return `${kept.join('\n')}\n…[truncated ${dropped} of ${rendered.length} lines]`;
}

function severityFor(lane: 'page' | 'triage', tier: PolicyTier): string {
  if (lane === 'page') return 'page';
  return tier <= 1 ? 'warn' : 'info';
}

function titleFor(incident: Incident, primary: LogSignal | null, containers: readonly string[]): string {
  const subject = containers[0] ? `${containers[0]}/${incident.host}` : incident.host;
  const cause = primary?.ruleNames[0] ?? (primary?.shapeId ? 'log pattern' : 'log incident');
  const windowSec = Math.max(1, Math.round((incident.lastSignalAt - incident.openedAt) / 1000));
  const title = `${subject}: ${cause}, ${incident.signalCount} in ${windowSec}s`;
  return title.length > TITLE_MAX_CHARS ? title.slice(0, TITLE_MAX_CHARS) : title;
}

function healthyFor(event: SignalEvent | null): string {
  if (!event || event.healthStatus === null) return '';
  return event.healthStatus === 'healthy' ? 'yes' : 'no';
}

export function buildHermesPayload(input: BuildPayloadInput): HermesPayload {
  const { incident, occurrence, lane, route, at, digest, dashboardBaseUrl } = input;
  const primary = primarySignal(incident);
  const { lineCount, stderrCount } = aggregateLineCounts(incident);
  const containers = containerNamesFor(incident);
  const { ruleIds, ruleNames } = aggregateRules(incident, primary);
  const shapeIds = aggregateShapeIds(incident);
  const excerptLines = aggregateExcerptLines(incident);

  let excerptMaxBytes = EXCERPT_MAX_BYTES;
  let includeDigest = incident.tier === 0;
  let truncateLists = false;

  const build = (): HermesPayload => {
    const cappedRuleIds = truncateLists ? ruleIds.slice(0, JOIN_LIST_CAP) : ruleIds;
    const cappedRuleNames = truncateLists ? ruleNames.slice(0, JOIN_LIST_CAP) : ruleNames;
    const cappedShapeIds = truncateLists ? shapeIds.slice(0, JOIN_LIST_CAP) : shapeIds;
    const cappedMergedFrom = truncateLists ? incident.mergedFrom.slice(0, JOIN_LIST_CAP) : incident.mergedFrom;
    const fields: Record<string, string | number> = {
      version: '1',
      incidentId: incident.id,
      occurrence,
      tier: incident.tier,
      lane,
      route,
      scope: incident.scope,
      severity: severityFor(lane, incident.tier),
      title: titleFor(incident, primary, containers),
      at: isoString(at),
      windowStart: isoString(incident.openedAt),
      windowEnd: isoString(incident.lastSignalAt),
      host: incident.host,
      entityId: incident.primaryEntityId,
      container: primary?.containerName ?? '',
      image: primary?.image ?? '',
      stack: incident.stackProject ?? '',
      service: primary?.serviceKey ?? '',
      entityCount: incident.entityIds.length,
      entities: joinCapped(incident.entityIds),
      containers: joinCapped(containers),
      ruleIds: cappedRuleIds.join(','),
      ruleNames: cappedRuleNames.join(','),
      shapeIds: cappedShapeIds.join(','),
      signalCount: incident.signalCount,
      lineCount,
      stderrCount,
      stderrRatio: lineCount > 0 ? (stderrCount / lineCount).toFixed(3) : '',
      baselineExpected:
        primary?.metrics.baselineExpected !== null && primary?.metrics.baselineExpected !== undefined
          ? primary.metrics.baselineExpected.toFixed(2)
          : '',
      baselineZ:
        primary?.metrics.baselineZ !== null && primary?.metrics.baselineZ !== undefined
          ? primary.metrics.baselineZ.toFixed(2)
          : '',
      coldStart: yesNo(primary?.coldStart ?? false),
      sinceImageChangeMs:
        primary?.sinceImageChangeMs !== null && primary?.sinceImageChangeMs !== undefined
          ? String(primary.sinceImageChangeMs)
          : '',
      eventType: primary?.event?.eventType ?? '',
      exitCode: primary?.event?.exitCode !== null && primary?.event?.exitCode !== undefined ? String(primary.event.exitCode) : '',
      oomKilled: primary?.event ? yesNo(primary.event.oomKilled) : '',
      healthy: healthyFor(primary?.event ?? null),
      restartsInWindow: primary?.event ? String(primary.event.restartsInWindow) : '',
      mergedFrom: cappedMergedFrom.join(','),
      excerpt: renderExcerpt(excerptLines, excerptMaxBytes),
      digest: includeDigest ? (digest ?? '') : '',
      dashboardUrl: dashboardBaseUrl ? `${dashboardBaseUrl.replace(/\/$/, '')}/incidents/${incident.id}` : '',
    };
    return Object.freeze(fields);
  };

  let payload = build();
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') <= PAYLOAD_MAX_BYTES) return payload;

  includeDigest = false;
  payload = build();
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') <= PAYLOAD_MAX_BYTES) return payload;

  excerptMaxBytes = Math.floor(EXCERPT_MAX_BYTES / 2);
  payload = build();
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') <= PAYLOAD_MAX_BYTES) return payload;

  truncateLists = true;
  payload = build();
  const finalBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (finalBytes <= PAYLOAD_MAX_BYTES) return payload;

  throw new PayloadTooLargeError(finalBytes, incident.id);
}

export interface SignedHeaders {
  readonly 'X-Webhook-Signature-V2': string;
  readonly 'X-Webhook-Timestamp': string;
  readonly 'X-Request-ID': string;
  readonly 'Content-Type': 'application/json';
}

export function signHermesRequest(
  body: string,
  secret: string,
  timestampSeconds: number,
  requestId: string,
): SignedHeaders {
  const signature = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`, 'utf8').digest('hex');
  return {
    'X-Webhook-Signature-V2': signature,
    'X-Webhook-Timestamp': String(timestampSeconds),
    'X-Request-ID': requestId,
    'Content-Type': 'application/json',
  };
}

export type DeliveryOutcome =
  | 'accepted'
  | 'duplicate'
  | 'rate-limited'
  | 'rejected'
  | 'transport'
  | 'circuit-open'
  | 'budget-exhausted'
  | 'queue-dropped'
  | 'disabled';

export interface DeliveryResult {
  readonly outcome: DeliveryOutcome;
  readonly status: number | null;
  readonly attempts: number;
  readonly requestId: string;
  readonly route: string;
  readonly errorMessage: string | null;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface HermesRuntimeConfig {
  readonly enabled: boolean;
  readonly gatewayUrl: string;
  readonly secret: string;
  readonly dashboardBaseUrl: string;
}

export type BudgetBucket = 't0' | 't1' | 't2' | 'page';

export interface BudgetStore {
  load(day: string): Promise<Record<BudgetBucket, number>>;
  increment(day: string, bucket: BudgetBucket, by: number): Promise<void>;
}

export interface HermesDispatcherOptions {
  readonly clock?: Clock;
  readonly fetchFn?: FetchFn;
  readonly signal: AbortSignal;
  readonly configProvider: () => Promise<HermesRuntimeConfig>;
  readonly budgetStore: BudgetStore;
  readonly ceilingsProvider: () => HermesCeilings;
  readonly digestProvider?: (entityId: string, now: number) => Promise<string>;
}

export interface DispatcherStats {
  readonly inFlight: Readonly<Record<'page' | 't0' | 't1' | 't2', number>>;
  readonly queued: Readonly<Record<'page' | 't0' | 't1' | 't2', number>>;
  readonly spentToday: Readonly<Record<'page' | 't0' | 't1' | 't2', number>>;
  readonly circuitOpenRoutes: readonly string[];
  readonly openIncidents: number;
}

export class CapacityGate {
  private capacity: DerivedCapacity;
  private globalInFlight = 0;
  private t0InFlight = 0;
  private t1InFlight = 0;
  private t2InFlight = 0;

  constructor(capacity: DerivedCapacity) {
    this.capacity = capacity;
  }

  update(capacity: DerivedCapacity): void {
    this.capacity = capacity;
  }

  tryAcquire(tier: 0 | 1 | 2): boolean {
    const { maxInFlight, sharedPool, t2Ceiling } = this.capacity;
    if (this.globalInFlight >= maxInFlight) return false;
    const nonT0InFlight = this.t1InFlight + this.t2InFlight;
    if (tier !== 0 && nonT0InFlight >= sharedPool) return false;
    if (tier === 2 && this.t2InFlight >= t2Ceiling) return false;

    this.globalInFlight += 1;
    if (tier === 0) this.t0InFlight += 1;
    else if (tier === 1) this.t1InFlight += 1;
    else this.t2InFlight += 1;
    return true;
  }

  release(tier: 0 | 1 | 2): void {
    this.globalInFlight = Math.max(0, this.globalInFlight - 1);
    if (tier === 0) this.t0InFlight = Math.max(0, this.t0InFlight - 1);
    else if (tier === 1) this.t1InFlight = Math.max(0, this.t1InFlight - 1);
    else this.t2InFlight = Math.max(0, this.t2InFlight - 1);
  }

  inFlight(): Readonly<Record<'t0' | 't1' | 't2', number>> {
    return { t0: this.t0InFlight, t1: this.t1InFlight, t2: this.t2InFlight };
  }
}

type LaneKey = 'page' | 't0' | 't1' | 't2';

interface QueuedDispatch {
  readonly incident: Incident;
  readonly lane: 'page' | 'triage';
  readonly tier: 0 | 1 | 2;
  readonly occurrence: number;
  readonly route: string;
}

interface CircuitState {
  consecutiveFailures: number;
  openUntil: number | null;
}

function bucketFor(lane: 'page' | 'triage', tier: 0 | 1 | 2): BudgetBucket {
  return lane === 'page' ? 'page' : (`t${tier}` as BudgetBucket);
}

function dailyLimitFor(bucket: BudgetBucket, capacity: DerivedCapacity): number {
  return bucket === 'page' ? capacity.dailyPages : capacity.dailyByBucket[bucket];
}

function dayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function laneKeyFor(lane: 'page' | 'triage', tier: 0 | 1 | 2): LaneKey {
  return lane === 'page' ? 'page' : (`t${tier}` as LaneKey);
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return undefined;
}

async function safeText(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export class HermesDispatcher implements AsyncDisposable {
  private readonly clock: Clock;
  private readonly fetchFn: FetchFn;
  private readonly signal: AbortSignal;
  private readonly configProvider: () => Promise<HermesRuntimeConfig>;
  private readonly budgetStore: BudgetStore;
  private readonly ceilingsProvider: () => HermesCeilings;
  private readonly digestProvider?: (entityId: string, now: number) => Promise<string>;

  private readonly coalescer = new IncidentCoalescer();
  private readonly gate: CapacityGate;
  private readonly queues: Record<LaneKey, PQueue>;
  private readonly fifos: Record<LaneKey, QueuedDispatch[]> = { page: [], t0: [], t1: [], t2: [] };
  private readonly capacityWaiters: Array<{ tier: 0 | 1 | 2; resolve: () => void }> = [];
  private readonly circuits = new Map<string, CircuitState>();
  private readonly lastFiredAt = new Map<string, number>();
  private readonly runningByHost = new Map<string, number>();
  private readonly warnedBucketDay = new Map<BudgetBucket, string>();

  private capacityState: DerivedCapacity;
  private cachedConfig: HermesRuntimeConfig | null = null;
  private configLoadedAt = 0;
  private budgetDay: string | null = null;
  private spentToday: Record<BudgetBucket, number> = { t0: 0, t1: 0, t2: 0, page: 0 };
  /** In-flight reservations not yet settled; merged into a day-rollover load so a pending increment() can't be clobbered by a concurrent load(). */
  private pendingSpend: Record<BudgetBucket, number> = { t0: 0, t1: 0, t2: 0, page: 0 };
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(options: HermesDispatcherOptions) {
    this.clock = options.clock ?? systemClock;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.signal = options.signal;
    this.configProvider = options.configProvider;
    this.budgetStore = options.budgetStore;
    this.ceilingsProvider = options.ceilingsProvider;
    this.digestProvider = options.digestProvider;

    this.capacityState = deriveCapacity(0, this.ceilingsProvider());
    this.gate = new CapacityGate(this.capacityState);
    this.queues = {
      page: new PQueue({ concurrency: PAGE_CONCURRENCY }),
      t0: new PQueue({ concurrency: this.capacityState.maxInFlight }),
      t1: new PQueue({ concurrency: this.capacityState.sharedPool }),
      t2: new PQueue({ concurrency: this.capacityState.t2Ceiling }),
    };
  }

  submit(signal: LogSignal): void {
    const now = this.clock.now();
    const result = this.coalescer.admit(signal, now);
    if (result.immediatePages.length > 0) {
      this.dispatchImmediatePage(result.incident, now);
    }
  }

  setRunningContainerCount(host: string, running: number): void {
    this.runningByHost.set(host, Math.max(0, running));
    const total = [...this.runningByHost.values()].reduce((sum, n) => sum + n, 0);
    this.capacityState = deriveCapacity(total, this.ceilingsProvider());
    this.gate.update(this.capacityState);
    this.queues.t0.concurrency = this.capacityState.maxInFlight;
    this.queues.t1.concurrency = this.capacityState.sharedPool;
    this.queues.t2.concurrency = this.capacityState.t2Ceiling;
  }

  capacity(): DerivedCapacity {
    return this.capacityState;
  }

  start(): void {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(() => {
      void this.tick(this.clock.now());
    }, DISPATCH_TICK_MS);
  }

  async tick(now: number): Promise<void> {
    await this.ensureBudgetLoaded(now);
    this.coalescer.sweep(now);
    const due = this.coalescer.due(now, (tier) => policyFor(tier as PolicyTier).debounceMs);
    for (const { incident } of due) {
      this.considerDueIncident(incident, now);
    }
    for (const key of ['page', 't0', 't1', 't2'] as const) {
      this.pump(key);
    }
  }

  stats(): DispatcherStats {
    const inFlight = this.gate.inFlight();
    return {
      inFlight: {
        page: this.queues.page.pending,
        t0: inFlight.t0,
        t1: inFlight.t1,
        t2: inFlight.t2,
      },
      queued: {
        page: this.fifos.page.length + this.queues.page.size,
        t0: this.fifos.t0.length + this.queues.t0.size,
        t1: this.fifos.t1.length + this.queues.t1.size,
        t2: this.fifos.t2.length + this.queues.t2.size,
      },
      spentToday: { ...this.spentToday },
      circuitOpenRoutes: [...this.circuits.entries()]
        .filter(([, state]) => state.openUntil !== null && state.openUntil > this.clock.now())
        .map(([route]) => route),
      openIncidents: this.coalescer.open().length,
    };
  }

  /** Test seam: resolves once every lane's FIFO has drained and every in-flight delivery has settled. */
  async waitForIdle(): Promise<void> {
    while (
      this.fifos.page.length > 0 ||
      this.fifos.t0.length > 0 ||
      this.fifos.t1.length > 0 ||
      this.fifos.t2.length > 0 ||
      this.queues.page.size + this.queues.page.pending > 0 ||
      this.queues.t0.size + this.queues.t0.pending > 0 ||
      this.queues.t1.size + this.queues.t1.pending > 0 ||
      this.queues.t2.size + this.queues.t2.pending > 0
    ) {
      await Promise.all([this.queues.page.onIdle(), this.queues.t0.onIdle(), this.queues.t1.onIdle(), this.queues.t2.onIdle()]);
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    await Promise.allSettled([this.queues.page.onIdle(), this.queues.t0.onIdle(), this.queues.t1.onIdle(), this.queues.t2.onIdle()]);
  }

  private dispatchImmediatePage(incident: Incident, now: number): void {
    const trialEntry: QueuedDispatch = {
      incident,
      lane: 'page',
      tier: incident.tier,
      occurrence: incident.occurrence || 1,
      route: PAGE_ROUTE,
    };
    if (!this.checkCooldownAndBudget(trialEntry, now)) return;

    const marked = this.coalescer.markDispatched(incident.id, now) ?? incident;
    this.enqueue('page', {
      incident: { ...marked },
      lane: 'page',
      tier: marked.tier,
      occurrence: marked.occurrence || 1,
      route: PAGE_ROUTE,
    });
  }

  /**
   * Always routes as 'triage', never the incident's accumulated `lane` (which never demotes
   * back from 'page'): any page for this incident already went out via dispatchImmediatePage.
   */
  private considerDueIncident(incident: Incident, now: number): void {
    const laneKey = laneKeyFor('triage', incident.tier);
    const alreadyQueued =
      this.fifos[laneKey].some((e) => e.incident.id === incident.id) || this.isIncidentInFlight(incident.id);
    if (alreadyQueued) return;

    const trialEntry: QueuedDispatch = {
      incident,
      lane: 'triage',
      tier: incident.tier,
      occurrence: incident.occurrence,
      route: routeFor(incident.tier, 'triage'),
    };
    if (!this.checkCooldownAndBudget(trialEntry, now)) return;

    const marked = this.coalescer.markDispatched(incident.id, now);
    const effective = marked ?? incident;
    this.enqueue(laneKey, {
      incident: { ...effective },
      lane: 'triage',
      tier: effective.tier,
      occurrence: effective.occurrence,
      route: routeFor(effective.tier, 'triage'),
    });
  }

  private readonly inFlightIncidentIds = new Set<string>();

  private isIncidentInFlight(incidentId: string): boolean {
    return this.inFlightIncidentIds.has(incidentId);
  }

  private checkCooldownAndBudget(entry: QueuedDispatch, now: number): boolean {
    if (!this.isCooledDown(entry.incident, entry.tier, now)) {
      console.info(`[HermesDispatcher] cooldown active for incident ${entry.incident.id}, dropping dispatch`);
      return false;
    }

    const bucket = bucketFor(entry.lane, entry.tier);
    const limit = dailyLimitFor(bucket, this.capacityState);
    if (this.spentToday[bucket] >= limit) {
      this.logBudgetExhausted(bucket, now);
      return false;
    }

    for (const entityId of entry.incident.entityIds) {
      this.lastFiredAt.set(entityId, now);
    }
    this.spentToday[bucket] += 1;
    this.pendingSpend[bucket] += 1;
    return true;
  }

  private releaseReservedSpend(entry: QueuedDispatch): void {
    const bucket = bucketFor(entry.lane, entry.tier);
    this.spentToday[bucket] = Math.max(0, this.spentToday[bucket] - 1);
    this.pendingSpend[bucket] = Math.max(0, this.pendingSpend[bucket] - 1);
  }

  private isCooledDown(incident: Incident, tier: 0 | 1 | 2, now: number): boolean {
    const cooldownMs = policyFor(tier as PolicyTier).cooldownMs;
    return incident.entityIds.some((entityId) => {
      const last = this.lastFiredAt.get(entityId);
      return last === undefined || now - last >= cooldownMs;
    });
  }

  private logBudgetExhausted(bucket: BudgetBucket, now: number): void {
    const today = dayKey(now);
    const lastWarned = this.warnedBucketDay.get(bucket);
    if (lastWarned !== today) {
      this.warnedBucketDay.set(bucket, today);
      console.warn(`[HermesDispatcher] daily budget exhausted for bucket ${bucket}, dropping dispatch`);
    } else {
      console.info(`[HermesDispatcher] daily budget exhausted for bucket ${bucket}, dropping dispatch`);
    }
  }

  private enqueue(key: LaneKey, entry: QueuedDispatch): void {
    const fifo = this.fifos[key];
    fifo.push(entry);
    if (fifo.length > MAX_QUEUED_PER_LANE) {
      const dropped = fifo.shift();
      if (dropped) this.releaseReservedSpend(dropped);
      console.warn(`[HermesDispatcher] lane ${key} queue overflow, dropped oldest entry`);
    }
    this.pump(key);
  }

  private pump(key: LaneKey): void {
    const queue = this.queues[key];
    const fifo = this.fifos[key];
    while (fifo.length > 0 && queue.size + queue.pending < queue.concurrency * 2) {
      const entry = fifo.shift();
      if (!entry) break;
      this.inFlightIncidentIds.add(entry.incident.id);
      void queue
        .add(() => this.executeDispatch(entry, key), { priority: LANE_SEVERITY[entry.lane] })
        .finally(() => {
          this.inFlightIncidentIds.delete(entry.incident.id);
          this.pump(key);
        });
    }
  }

  private async executeDispatch(entry: QueuedDispatch, key: LaneKey): Promise<void> {
    const useGate = key !== 'page';
    if (useGate) {
      await this.acquireCapacity(entry.tier);
    }
    try {
      const result = await this.deliverWithRetry(entry);
      await this.settleSpend(entry, result);
    } finally {
      if (useGate) this.releaseCapacity(entry.tier);
    }
  }

  private async acquireCapacity(tier: 0 | 1 | 2): Promise<void> {
    if (this.gate.tryAcquire(tier)) return;
    await new Promise<void>((resolve) => {
      this.capacityWaiters.push({ tier, resolve });
    });
  }

  private releaseCapacity(tier: 0 | 1 | 2): void {
    this.gate.release(tier);
    for (let i = 0; i < this.capacityWaiters.length; i++) {
      const waiter = this.capacityWaiters[i];
      if (this.gate.tryAcquire(waiter.tier)) {
        this.capacityWaiters.splice(i, 1);
        waiter.resolve();
        return;
      }
    }
  }

  /**
   * checkCooldownAndBudget reserves spend at enqueue time so concurrently queued dispatches
   * for the same bucket can't all pass the daily-limit check before any of them completes;
   * a non-accepted outcome releases that reservation here instead of persisting it.
   */
  private async settleSpend(entry: QueuedDispatch, result: DeliveryResult): Promise<void> {
    const bucket = bucketFor(entry.lane, entry.tier);
    if (result.outcome !== 'accepted') {
      this.releaseReservedSpend(entry);
      return;
    }
    const day = dayKey(this.clock.now());
    try {
      await this.budgetStore.increment(day, bucket, 1);
    } catch (err) {
      console.error(`[HermesDispatcher] failed to persist budget spend for ${bucket}: ${String(err)}`);
    } finally {
      this.pendingSpend[bucket] = Math.max(0, this.pendingSpend[bucket] - 1);
    }
  }

  private async ensureBudgetLoaded(now: number): Promise<void> {
    const today = dayKey(now);
    if (this.budgetDay === today) return;
    this.budgetDay = today;
    try {
      const loaded = await this.budgetStore.load(today);
      this.spentToday = {
        t0: (loaded.t0 ?? 0) + this.pendingSpend.t0,
        t1: (loaded.t1 ?? 0) + this.pendingSpend.t1,
        t2: (loaded.t2 ?? 0) + this.pendingSpend.t2,
        page: (loaded.page ?? 0) + this.pendingSpend.page,
      };
    } catch (err) {
      console.error(`[HermesDispatcher] failed to load budget for ${today}: ${String(err)}`);
      this.spentToday = { ...this.pendingSpend };
    }
  }

  private async getConfig(now: number): Promise<HermesRuntimeConfig> {
    if (this.cachedConfig && now - this.configLoadedAt < CONFIG_TTL_MS) {
      return this.cachedConfig;
    }
    const config = await this.configProvider();
    this.cachedConfig = config;
    this.configLoadedAt = now;
    return config;
  }

  private isCircuitOpen(route: string): boolean {
    const now = this.clock.now();
    const state = this.circuits.get(route);
    if (!state || state.openUntil === null) return false;
    if (now >= state.openUntil) {
      state.openUntil = null;
      state.consecutiveFailures = 0;
      console.info(`[HermesDispatcher] circuit closed for route ${route}`);
      return false;
    }
    return true;
  }

  private recordCircuitFailure(route: string): void {
    const state = this.circuits.get(route) ?? { consecutiveFailures: 0, openUntil: null };
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD && state.openUntil === null) {
      state.openUntil = this.clock.now() + CIRCUIT_OPEN_MS;
      console.warn(`[HermesDispatcher] circuit open for route ${route} after ${state.consecutiveFailures} consecutive failures`);
    }
    this.circuits.set(route, state);
  }

  private recordCircuitSuccess(route: string): void {
    this.circuits.set(route, { consecutiveFailures: 0, openUntil: null });
  }

  private requestIdFor(entry: QueuedDispatch): string {
    return `${entry.incident.id}-${entry.occurrence}`;
  }

  private async loadDigest(entry: QueuedDispatch, now: number): Promise<string> {
    if (entry.tier !== 0 || !this.digestProvider) return '';
    try {
      return await this.digestProvider(entry.incident.primaryEntityId, now);
    } catch (err) {
      console.error(`[HermesDispatcher] digest provider failed for ${entry.incident.primaryEntityId}: ${String(err)}`);
      return '';
    }
  }

  private buildUrl(gatewayUrl: string, route: string): string {
    return `${gatewayUrl.replace(/\/$/, '')}/webhooks/${route}`;
  }

  private async sendOnce(url: string, body: string, headers: SignedHeaders): Promise<Response> {
    const composedSignal = AbortSignal.any([AbortSignal.timeout(HTTP_TIMEOUT_MS), this.signal]);
    return this.fetchFn(url, {
      method: 'POST',
      headers: headers as unknown as Record<string, string>,
      body,
      signal: composedSignal,
    });
  }

  private async classifyResponse(
    response: Response,
    bodyBytes: number,
    entry: QueuedDispatch,
  ): Promise<{ outcome: DeliveryOutcome; errorMessage: string | null; retryAfterMs?: number }> {
    const status = response.status;
    if (status === 200) {
      let parsedDuplicate = false;
      try {
        const parsed = (await response.clone().json()) as unknown;
        if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).status === 'duplicate') {
          parsedDuplicate = true;
        }
      } catch {
        parsedDuplicate = false;
      }
      await safeText(response);
      return { outcome: parsedDuplicate ? 'duplicate' : 'accepted', errorMessage: null };
    }
    if (status >= 200 && status < 300) {
      await safeText(response);
      return { outcome: 'accepted', errorMessage: null };
    }
    if (status === 429) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      const text = await safeText(response);
      return { outcome: 'rate-limited', errorMessage: text, retryAfterMs };
    }
    if (REJECTED_STATUSES.has(status)) {
      const text = await safeText(response);
      console.error(
        `[HermesDispatcher] ${entry.route} rejected incident ${entry.incident.id}: status=${status}${
          status === 413 ? ` bodyBytes=${bodyBytes}` : ''
        }`,
      );
      return { outcome: 'rejected', errorMessage: text };
    }
    const text = await safeText(response);
    return { outcome: 'transport', errorMessage: text };
  }

  private async backoffWait(attempt: number, retryAfterMs: number | undefined): Promise<void> {
    const computed = backoffDelayMs(attempt - 1, { baseMs: 500, capMs: 8_000, maxExponent: 4 });
    const delayMs = retryAfterMs !== undefined && retryAfterMs <= RETRY_AFTER_MAX_MS ? retryAfterMs : Math.random() * computed;
    await abortableSleep(delayMs, this.signal);
  }

  private async deliverWithRetry(entry: QueuedDispatch): Promise<DeliveryResult> {
    const now = this.clock.now();
    const requestId = this.requestIdFor(entry);
    const config = await this.getConfig(now);
    if (!config.enabled || !config.gatewayUrl || !config.secret) {
      console.info(`[HermesDispatcher] disabled, dropping incident ${entry.incident.id}`);
      return { outcome: 'disabled', status: null, attempts: 0, requestId, route: entry.route, errorMessage: null };
    }
    if (this.isCircuitOpen(entry.route)) {
      return { outcome: 'circuit-open', status: null, attempts: 0, requestId, route: entry.route, errorMessage: null };
    }

    const digest = await this.loadDigest(entry, now);
    let payload: HermesPayload;
    try {
      payload = buildHermesPayload({
        incident: entry.incident,
        occurrence: entry.occurrence,
        lane: entry.lane,
        route: entry.route,
        at: now,
        digest,
        dashboardBaseUrl: config.dashboardBaseUrl,
      });
    } catch (err) {
      console.error(`[HermesDispatcher] payload build failed for incident ${entry.incident.id}: ${String(err)}`);
      return { outcome: 'rejected', status: null, attempts: 0, requestId, route: entry.route, errorMessage: String(err) };
    }
    const body = JSON.stringify(payload);
    const bodyBytes = Buffer.byteLength(body, 'utf8');
    const url = this.buildUrl(config.gatewayUrl, entry.route);
    const deliveryDeadline = now + MAX_DELIVERY_MS;

    let attempts = 0;
    let lastStatus: number | null = null;
    let lastError: string | null = null;

    while (attempts < MAX_ATTEMPTS) {
      attempts += 1;
      const attemptNow = this.clock.now();
      if (attempts > 1 && attemptNow >= deliveryDeadline) break;

      const timestampSeconds = Math.floor(attemptNow / 1000);
      const headers = signHermesRequest(body, config.secret, timestampSeconds, requestId);

      let response: Response;
      try {
        response = await this.sendOnce(url, body, headers);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.recordCircuitFailure(entry.route);
        if (attempts >= MAX_ATTEMPTS) {
          return { outcome: 'transport', status: null, attempts, requestId, route: entry.route, errorMessage: lastError };
        }
        await this.backoffWait(attempts, undefined);
        continue;
      }

      const classification = await this.classifyResponse(response, bodyBytes, entry);
      lastStatus = response.status;
      lastError = classification.errorMessage;

      if (classification.outcome === 'accepted' || classification.outcome === 'duplicate') {
        this.recordCircuitSuccess(entry.route);
        return { outcome: classification.outcome, status: response.status, attempts, requestId, route: entry.route, errorMessage: null };
      }

      if (classification.outcome === 'rejected') {
        return { outcome: 'rejected', status: response.status, attempts, requestId, route: entry.route, errorMessage: lastError };
      }

      if (classification.outcome === 'rate-limited') {
        if (attempts >= MAX_ATTEMPTS) {
          console.warn(`[HermesDispatcher] ${entry.route} rate-limited, dropping incident ${entry.incident.id} after ${attempts} attempts`);
          return { outcome: 'rate-limited', status: response.status, attempts, requestId, route: entry.route, errorMessage: lastError };
        }
        await this.backoffWait(attempts, classification.retryAfterMs);
        continue;
      }

      this.recordCircuitFailure(entry.route);

      if (attempts >= MAX_ATTEMPTS) {
        return { outcome: 'transport', status: response.status, attempts, requestId, route: entry.route, errorMessage: lastError };
      }
      await this.backoffWait(attempts, undefined);
    }

    return { outcome: 'transport', status: lastStatus, attempts, requestId, route: entry.route, errorMessage: lastError };
  }
}
