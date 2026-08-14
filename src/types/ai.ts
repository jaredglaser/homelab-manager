/**
 * Domain types for AI fleet log analysis.
 *
 * Agent log stream → worker orchestrator → per-container analysis agent →
 * `ai_observations` / `ai_analysis_sessions` → NOTIFY → web broadcast service →
 * `/api/ai-analysis` SSE → `useAiAnalysis()`.
 */

import { z } from 'zod';

export const AI_SEVERITIES = ['info', 'notice', 'warning', 'critical'] as const;
export type AiSeverity = (typeof AI_SEVERITIES)[number];

export const zAiSeverity = z.enum(AI_SEVERITIES);

export type AiProfileStatus = 'pending' | 'profiling' | 'ready' | 'failed';
export type AiSessionStatus = 'active' | 'closed' | 'failed';
export type AiAlertStatus = 'open' | 'acknowledged' | 'dismissed';

/** A single log line handed to an analysis agent. */
export interface LogLine {
  /** Docker's RFC3339 line timestamp, epoch ms. Null when the line carried none. */
  at: number | null;
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface AiProviderConfig {
  baseUrl: string;
  model: string;
  /** Model used for the one-off skill-authoring pass; falls back to `model`. */
  profilerModel: string | null;
  /** True when an API key is stored. The key itself never leaves the server. */
  hasApiKey: boolean;
  maxContextTokens: number;
}

export interface AiContainerProfile {
  host: string;
  containerKey: string;
  enabled: boolean;
  status: AiProfileStatus;
  skillMarkdown: string | null;
  skillVersion: number;
  sampleStartedAt: Date | null;
  sampleEndedAt: Date | null;
  sampleLineCount: number;
  model: string | null;
  error: string | null;
  updatedAt: Date;
}

export interface AiAnalysisSession {
  id: string;
  host: string;
  containerKey: string;
  /** UTC calendar day the session covers, as `YYYY-MM-DD`. */
  day: string;
  status: AiSessionStatus;
  startedAt: Date;
  endedAt: Date | null;
  batchesProcessed: number;
  linesProcessed: number;
  runningSummary: string | null;
  reportMarkdown: string | null;
  model: string | null;
  error: string | null;
}

export interface AiObservation {
  id: number;
  sessionId: string;
  host: string;
  containerKey: string;
  at: Date;
  severity: AiSeverity;
  title: string;
  detail: string;
  evidence: string[];
  triaged: boolean;
}

export interface AiAlert {
  id: number;
  at: Date;
  severity: AiSeverity;
  title: string;
  summary: string;
  investigation: string | null;
  entities: string[];
  observationIds: number[];
  status: AiAlertStatus;
}

export const zAiAnalysisChangePayload = z.object({
  kind: z.enum(['profile', 'session', 'observation', 'alert']),
  host: z.string().nullish(),
  containerKey: z.string().nullish(),
});

export type AiAnalysisChangePayload = z.infer<typeof zAiAnalysisChangePayload>;

/** Everything the `/ai` route renders, refreshed as a whole on each change. */
export interface AiAnalysisSnapshot {
  profiles: AiContainerProfile[];
  sessions: AiAnalysisSession[];
  observations: AiObservation[];
  alerts: AiAlert[];
}
