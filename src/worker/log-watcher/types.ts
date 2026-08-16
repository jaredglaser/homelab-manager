import type { LogLane, LogStream, Tier } from '@/lib/logs/types';

export type { LogLane, LogStream, Tier };

export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

export type SignalTrigger = 'line' | 'tick' | 'event';
export type IncidentScope = 'container' | 'stack' | 'host';

export interface LogSignal {
  readonly at: number;
  readonly entityId: string;
  readonly host: string;
  readonly containerName: string;
  readonly image: string | null;
  readonly stackProject: string | null;
  readonly serviceKey: string | null;
  readonly tier: Tier;
  readonly lane: Extract<LogLane, 'page' | 'triage'>;
  readonly trigger: SignalTrigger;
  readonly decidingRuleId: string | null;
  readonly ruleIds: readonly string[];
  readonly ruleNames: readonly string[];
  readonly shapeId: string | null;
  readonly hardSignal: boolean;
  readonly coldStart: boolean;
  readonly sinceImageChangeMs: number | null;
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly metrics: SignalMetrics;
  readonly event: SignalEvent | null;
  readonly excerptLines: readonly ExcerptLine[];
}

export interface SignalMetrics {
  readonly windowMs: number;
  readonly lineCount: number;
  readonly stderrCount: number;
  readonly stderrRatio: number | null;
  readonly baselineExpected: number | null;
  readonly baselineZ: number | null;
}

export interface SignalEvent {
  readonly eventType: string;
  readonly state: string | null;
  readonly exitCode: number | null;
  readonly oomKilled: boolean;
  readonly healthStatus: string | null;
  readonly restartsInWindow: number;
}

export interface ExcerptLine {
  readonly at: number;
  readonly stream: LogStream;
  readonly text: string;
}

export type IncidentState = 'open' | 'dispatched' | 'closed';

export interface Incident {
  readonly id: string;
  readonly scope: IncidentScope;
  readonly scopeKey: string;
  readonly state: IncidentState;
  readonly openedAt: number;
  readonly lastSignalAt: number;
  readonly dispatchedAt: number | null;
  readonly occurrence: number;
  readonly tier: Tier;
  readonly lane: Extract<LogLane, 'page' | 'triage'>;
  readonly host: string;
  readonly stackProject: string | null;
  readonly primaryEntityId: string;
  readonly entityIds: readonly string[];
  readonly signalCount: number;
  readonly signals: readonly LogSignal[];
  readonly mergedFrom: readonly string[];
  readonly dispatchedFingerprint: string | null;
}

export interface EntityContext {
  readonly entityId: string;
  readonly host: string;
  readonly containerId: string;
  readonly containerName: string;
  readonly image: string | null;
  readonly stackProject: string | null;
  readonly serviceKey: string | null;
  readonly tier: Tier;
  readonly running: boolean;
}
