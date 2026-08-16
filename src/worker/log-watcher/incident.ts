import { createHash } from 'node:crypto';
import type { LogLane } from '@/lib/logs/types';
import type { Clock, Incident, IncidentScope, LogSignal } from './types';
import { mostCriticalTier, mostSevereLane } from './tier';

type SignalLane = Extract<LogLane, 'page' | 'triage'>;

function mostSevereSignalLane(a: SignalLane, b: SignalLane): SignalLane {
  return mostSevereLane(a, b) as SignalLane;
}

const DEFAULT_WINDOW_MS = 30_000;
const DEFAULT_MAX_WINDOW_MS = 300_000;
const DEFAULT_FOLLOWUP_WINDOW_MS = 300_000;
const DEFAULT_FOLLOWUP_MIN_INTERVAL_MS = 60_000;
const DEFAULT_MAX_RETAINED_SIGNALS = 50;
const DEFAULT_MAX_OPEN_INCIDENTS = 200;
const DEFAULT_STACK_SCOPE_MIN_ENTITIES = 2;
const DEFAULT_HOST_SCOPE_MIN_ENTITIES = 3;
const DEFAULT_HOST_SCOPE_MIN_STACKS = 2;

const SCOPE_PREFIX: Readonly<Record<IncidentScope, string>> = {
  container: 'inc-e',
  stack: 'inc-s',
  host: 'inc-h',
};

type MutableIncident = { -readonly [K in keyof Incident]: Incident[K] };

function defaultHash(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function uniqSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function uniqStable(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function withinWindow(incident: MutableIncident, now: number, windowMs: number, maxWindowMs: number): boolean {
  return now - incident.lastSignalAt <= windowMs && now - incident.openedAt <= maxWindowMs;
}

function formatScopeKey(scope: IncidentScope, host: string, stackProject: string | null, entityId: string): string {
  if (scope === 'container') return `entity:${entityId}`;
  if (scope === 'stack') return `stack:${host}/${stackProject ?? ''}`;
  return `host:${host}`;
}

export interface CoalescerOptions {
  readonly windowMs?: number;
  readonly maxWindowMs?: number;
  readonly followupWindowMs?: number;
  readonly followupMinIntervalMs?: number;
  readonly maxRetainedSignals?: number;
  readonly maxOpenIncidents?: number;
  readonly stackScopeMinEntities?: number;
  readonly hostScopeMinEntities?: number;
  readonly hostScopeMinStacks?: number;
  readonly hash?: (input: string) => string;
}

export interface AdmitResult {
  readonly immediatePages: readonly LogSignal[];
  readonly incident: Incident;
  readonly promoted: boolean;
  readonly absorbedIds: readonly string[];
}

export interface DueIncident {
  readonly incident: Incident;
  readonly reason: 'debounce' | 'followup';
}

export function incidentIdFor(
  scope: IncidentScope,
  scopeKey: string,
  openedAt: number,
  hash: (input: string) => string = defaultHash,
): string {
  return `${SCOPE_PREFIX[scope]}-${hash(`${scopeKey}\u001f${openedAt}`).slice(0, 12)}`;
}

export function incidentFingerprint(incident: Incident): string {
  const entityIds = [...incident.entityIds].sort();
  const ruleIds = uniqSorted(incident.signals.flatMap((s) => s.ruleIds));
  const payload = `${entityIds.join(',')}\u001f${ruleIds.join(',')}\u001f${incident.lane}`;
  return createHash('sha256').update(payload).digest('hex');
}

export function scopeKeyFor(scope: IncidentScope, signal: LogSignal): string {
  return formatScopeKey(scope, signal.host, signal.stackProject, signal.entityId);
}

interface PromotionResult {
  readonly incident: MutableIncident;
  readonly absorbedIds: readonly string[];
}

export class IncidentCoalescer {
  private readonly incidents = new Map<string, MutableIncident>();
  private readonly entityToIncident = new Map<string, string>();
  private readonly windowMs: number;
  private readonly maxWindowMs: number;
  private readonly followupWindowMs: number;
  private readonly followupMinIntervalMs: number;
  private readonly maxRetainedSignals: number;
  private readonly maxOpenIncidents: number;
  private readonly stackScopeMinEntities: number;
  private readonly hostScopeMinEntities: number;
  private readonly hostScopeMinStacks: number;
  private readonly hash: (input: string) => string;

  constructor(options: CoalescerOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxWindowMs = options.maxWindowMs ?? DEFAULT_MAX_WINDOW_MS;
    this.followupWindowMs = options.followupWindowMs ?? DEFAULT_FOLLOWUP_WINDOW_MS;
    this.followupMinIntervalMs = options.followupMinIntervalMs ?? DEFAULT_FOLLOWUP_MIN_INTERVAL_MS;
    this.maxRetainedSignals = options.maxRetainedSignals ?? DEFAULT_MAX_RETAINED_SIGNALS;
    this.maxOpenIncidents = options.maxOpenIncidents ?? DEFAULT_MAX_OPEN_INCIDENTS;
    this.stackScopeMinEntities = options.stackScopeMinEntities ?? DEFAULT_STACK_SCOPE_MIN_ENTITIES;
    this.hostScopeMinEntities = options.hostScopeMinEntities ?? DEFAULT_HOST_SCOPE_MIN_ENTITIES;
    this.hostScopeMinStacks = options.hostScopeMinStacks ?? DEFAULT_HOST_SCOPE_MIN_STACKS;
    this.hash = options.hash ?? defaultHash;
  }

  admit(signal: LogSignal, now: number): AdmitResult {
    const immediatePages = signal.lane === 'page' ? [signal] : [];
    const result = this.joinOrCreate(signal, now);
    return {
      immediatePages,
      incident: result.incident,
      promoted: result.promoted,
      absorbedIds: result.absorbedIds,
    };
  }

  due(now: number, debounceMsForTier: (tier: number) => number): readonly DueIncident[] {
    const results: DueIncident[] = [];
    for (const incident of this.incidents.values()) {
      if (incident.state === 'open') {
        if (now - incident.openedAt >= debounceMsForTier(incident.tier)) {
          results.push({ incident, reason: 'debounce' });
        }
      } else if (incident.state === 'dispatched' && incident.dispatchedAt !== null) {
        const stillJoinable = now - incident.lastSignalAt <= this.followupWindowMs;
        const pastMinInterval = now - incident.dispatchedAt >= this.followupMinIntervalMs;
        const changed = incidentFingerprint(incident) !== incident.dispatchedFingerprint;
        if (stillJoinable && pastMinInterval && changed) {
          results.push({ incident, reason: 'followup' });
        }
      }
    }
    return results;
  }

  markDispatched(incidentId: string, now: number): Incident | null {
    const incident = this.incidents.get(incidentId);
    if (!incident) return null;
    incident.state = 'dispatched';
    incident.dispatchedAt = now;
    incident.occurrence += 1;
    incident.dispatchedFingerprint = incidentFingerprint(incident);
    return incident;
  }

  sweep(now: number): readonly Incident[] {
    const closed: MutableIncident[] = [];
    for (const incident of [...this.incidents.values()]) {
      if (incident.state === 'open' && !withinWindow(incident, now, this.windowMs, this.maxWindowMs)) {
        incident.state = 'closed';
        this.incidents.delete(incident.id);
        this.releaseEntities(incident);
        closed.push(incident);
      } else if (incident.state === 'dispatched' && now - incident.lastSignalAt > this.followupWindowMs) {
        incident.state = 'closed';
        this.incidents.delete(incident.id);
        this.releaseEntities(incident);
        closed.push(incident);
      }
    }
    return closed;
  }

  get(incidentId: string): Incident | null {
    return this.incidents.get(incidentId) ?? null;
  }

  open(): readonly Incident[] {
    return [...this.incidents.values()].filter((i) => i.state === 'open');
  }

  size(): number {
    return this.incidents.size;
  }

  private joinOrCreate(signal: LogSignal, now: number): { incident: MutableIncident; promoted: boolean; absorbedIds: string[] } {
    const existingId = this.entityToIncident.get(signal.entityId);
    const existing = existingId ? this.incidents.get(existingId) : undefined;

    if (existing && existing.state === 'open' && withinWindow(existing, now, this.windowMs, this.maxWindowMs)) {
      this.joinSignal(existing, signal, now);
      this.enforceMaxOpen();
      return { incident: existing, promoted: false, absorbedIds: [] };
    }

    if (existing && existing.state === 'dispatched' && now - existing.lastSignalAt <= this.followupWindowMs) {
      this.joinSignal(existing, signal, now);
      return { incident: existing, promoted: false, absorbedIds: [] };
    }

    const hostKey = formatScopeKey('host', signal.host, null, signal.entityId);
    const hostIncident = this.findOpenIncident('host', hostKey, now);
    if (hostIncident) {
      this.joinSignal(hostIncident, signal, now);
      this.entityToIncident.set(signal.entityId, hostIncident.id);
      this.enforceMaxOpen();
      return { incident: hostIncident, promoted: false, absorbedIds: [] };
    }

    if (signal.stackProject) {
      const stackKey = formatScopeKey('stack', signal.host, signal.stackProject, signal.entityId);
      const stackIncident = this.findOpenIncident('stack', stackKey, now);
      if (stackIncident) {
        this.joinSignal(stackIncident, signal, now);
        this.entityToIncident.set(signal.entityId, stackIncident.id);
        const hostPromotion = this.attemptHostPromotion(signal.host, now);
        this.enforceMaxOpen();
        if (hostPromotion) {
          return { incident: hostPromotion.incident, promoted: true, absorbedIds: [...hostPromotion.absorbedIds] };
        }
        return { incident: stackIncident, promoted: false, absorbedIds: [] };
      }
    }

    const created = this.createContainerIncident(signal, now);
    this.incidents.set(created.id, created);
    this.entityToIncident.set(signal.entityId, created.id);

    const promotion = this.attemptPromotion(signal.host, signal.stackProject, now);
    this.enforceMaxOpen();
    if (promotion) {
      return { incident: promotion.incident, promoted: true, absorbedIds: [...promotion.absorbedIds] };
    }
    return { incident: created, promoted: false, absorbedIds: [] };
  }

  private createContainerIncident(signal: LogSignal, now: number): MutableIncident {
    const scopeKey = formatScopeKey('container', signal.host, signal.stackProject, signal.entityId);
    const id = incidentIdFor('container', scopeKey, now, this.hash);
    return {
      id,
      scope: 'container',
      scopeKey,
      state: 'open',
      openedAt: now,
      lastSignalAt: now,
      dispatchedAt: null,
      occurrence: 0,
      tier: signal.tier,
      lane: signal.lane,
      host: signal.host,
      stackProject: signal.stackProject,
      primaryEntityId: signal.entityId,
      entityIds: [signal.entityId],
      signalCount: 1,
      signals: [signal],
      mergedFrom: [],
      dispatchedFingerprint: null,
    };
  }

  private joinSignal(incident: MutableIncident, signal: LogSignal, now: number): void {
    const signals = [...incident.signals, signal];
    incident.signals = signals.length > this.maxRetainedSignals ? signals.slice(signals.length - this.maxRetainedSignals) : signals;
    incident.signalCount += 1;
    if (!incident.entityIds.includes(signal.entityId)) {
      incident.entityIds = uniqSorted([...incident.entityIds, signal.entityId]);
    }
    incident.tier = mostCriticalTier(incident.tier, signal.tier);
    incident.lane = mostSevereSignalLane(incident.lane, signal.lane);
    incident.lastSignalAt = Math.max(incident.lastSignalAt, now);
    if (incident.scope !== 'host') {
      incident.stackProject = signal.stackProject;
    }
  }

  private findOpenIncident(scope: IncidentScope, scopeKey: string, now: number): MutableIncident | undefined {
    for (const incident of this.incidents.values()) {
      if (
        incident.scope === scope &&
        incident.scopeKey === scopeKey &&
        incident.state === 'open' &&
        withinWindow(incident, now, this.windowMs, this.maxWindowMs)
      ) {
        return incident;
      }
    }
    return undefined;
  }

  private attemptPromotion(host: string, stackProject: string | null, now: number): PromotionResult | null {
    const stackResult = stackProject ? this.attemptStackPromotion(host, stackProject, now) : null;
    const hostResult = this.attemptHostPromotion(host, now);
    if (hostResult) return hostResult;
    return stackResult;
  }

  private attemptStackPromotion(host: string, stackProject: string, now: number): PromotionResult | null {
    const members = [...this.incidents.values()].filter(
      (i) => i.state === 'open' && i.scope !== 'host' && i.host === host && i.stackProject === stackProject && withinWindow(i, now, this.windowMs, this.maxWindowMs),
    );
    const distinctEntities = new Set(members.flatMap((m) => m.entityIds));
    if (distinctEntities.size < this.stackScopeMinEntities) return null;

    const excludeIds = new Set(members.map((m) => m.id));
    const siblingIds = this.collectDispatchedSiblingIds((i) => i.host === host && i.stackProject === stackProject, now, excludeIds);

    const scopeKey = formatScopeKey('stack', host, stackProject, '');
    const merged = this.mergeIncidents('stack', scopeKey, members, siblingIds);

    for (const m of members) this.incidents.delete(m.id);
    this.incidents.set(merged.id, merged);
    for (const eid of merged.entityIds) this.entityToIncident.set(eid, merged.id);

    return { incident: merged, absorbedIds: members.map((m) => m.id) };
  }

  private attemptHostPromotion(host: string, now: number): PromotionResult | null {
    const members = [...this.incidents.values()].filter(
      (i) => i.state === 'open' && i.scope !== 'host' && i.host === host && withinWindow(i, now, this.windowMs, this.maxWindowMs),
    );
    if (members.length === 0) return null;

    const distinctEntities = new Set(members.flatMap((m) => m.entityIds));
    const distinctStacks = new Set(members.map((m) => m.stackProject ?? ''));
    if (distinctEntities.size < this.hostScopeMinEntities || distinctStacks.size < this.hostScopeMinStacks) return null;

    const excludeIds = new Set(members.map((m) => m.id));
    const siblingIds = this.collectDispatchedSiblingIds((i) => i.host === host, now, excludeIds);

    const scopeKey = formatScopeKey('host', host, null, '');
    const merged = this.mergeIncidents('host', scopeKey, members, siblingIds);

    for (const m of members) this.incidents.delete(m.id);
    this.incidents.set(merged.id, merged);
    for (const eid of merged.entityIds) this.entityToIncident.set(eid, merged.id);

    return { incident: merged, absorbedIds: members.map((m) => m.id) };
  }

  private collectDispatchedSiblingIds(
    predicate: (incident: MutableIncident) => boolean,
    now: number,
    excludeIds: ReadonlySet<string>,
  ): string[] {
    const ids: string[] = [];
    for (const incident of this.incidents.values()) {
      if (incident.state !== 'dispatched') continue;
      if (excludeIds.has(incident.id)) continue;
      if (now - incident.lastSignalAt > this.followupWindowMs) continue;
      if (!predicate(incident)) continue;
      ids.push(incident.id);
    }
    return ids;
  }

  private mergeIncidents(
    scope: IncidentScope,
    scopeKey: string,
    members: readonly MutableIncident[],
    siblingIds: readonly string[],
  ): MutableIncident {
    const first = members[0];
    if (!first) throw new Error('mergeIncidents requires at least one member');

    const openedAt = Math.min(...members.map((m) => m.openedAt));
    const lastSignalAt = Math.max(...members.map((m) => m.lastSignalAt));
    const id = incidentIdFor(scope, scopeKey, openedAt, this.hash);
    const entityIds = uniqSorted(members.flatMap((m) => m.entityIds));
    const signals = members
      .flatMap((m) => m.signals)
      .slice()
      .sort((a, b) => a.at - b.at)
      .slice(-this.maxRetainedSignals);
    const signalCount = members.reduce((sum, m) => sum + m.signalCount, 0);
    const tier = members.reduce((t, m) => mostCriticalTier(t, m.tier), first.tier);
    const lane = members.reduce((l, m) => mostSevereSignalLane(l, m.lane), first.lane);
    const primaryEntityId = members.slice().sort((a, b) => a.openedAt - b.openedAt)[0]?.primaryEntityId ?? first.primaryEntityId;
    const mergedFrom = uniqStable([...members.flatMap((m) => [m.id, ...m.mergedFrom]), ...siblingIds]);
    const stackProject = scope === 'host' ? null : first.stackProject;

    return {
      id,
      scope,
      scopeKey,
      state: 'open',
      openedAt,
      lastSignalAt,
      dispatchedAt: null,
      occurrence: 0,
      tier,
      lane,
      host: first.host,
      stackProject,
      primaryEntityId,
      entityIds,
      signalCount,
      signals,
      mergedFrom,
      dispatchedFingerprint: null,
    };
  }

  private releaseEntities(incident: MutableIncident): void {
    for (const eid of incident.entityIds) {
      if (this.entityToIncident.get(eid) === incident.id) {
        this.entityToIncident.delete(eid);
      }
    }
  }

  /** Also bounds 'dispatched' incidents: one kept alive by recurring followup signals never returns to 'open'. */
  private enforceMaxOpen(): void {
    let liveList = [...this.incidents.values()].filter((i) => i.state === 'open' || i.state === 'dispatched');
    while (liveList.length > this.maxOpenIncidents) {
      liveList.sort((a, b) => a.openedAt - b.openedAt);
      const oldest = liveList[0];
      if (!oldest) break;
      oldest.state = 'closed';
      this.incidents.delete(oldest.id);
      this.releaseEntities(oldest);
      console.warn(`[IncidentCoalescer] forced close of oldest incident ${oldest.id}: max open incidents (${this.maxOpenIncidents}) exceeded`);
      liveList = liveList.slice(1);
    }
  }
}

export type { Clock };
