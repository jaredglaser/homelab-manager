import { z } from 'zod';
import { defineSseChannel } from '@/lib/sse/define-sse-channel';
import { zAiSeverity, type AiAnalysisSnapshot } from '@/types/ai';

const zProfile = z.object({
  host: z.string(),
  containerKey: z.string(),
  enabled: z.boolean(),
  status: z.enum(['pending', 'profiling', 'ready', 'failed']),
  skillMarkdown: z.string().nullable(),
  skillVersion: z.number(),
  sampleStartedAt: z.string().nullable(),
  sampleEndedAt: z.string().nullable(),
  sampleLineCount: z.number(),
  model: z.string().nullable(),
  error: z.string().nullable(),
  updatedAt: z.string(),
});

const zSession = z.object({
  id: z.string(),
  host: z.string(),
  containerKey: z.string(),
  day: z.string(),
  status: z.enum(['active', 'closed', 'failed']),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  batchesProcessed: z.number(),
  linesProcessed: z.number(),
  runningSummary: z.string().nullable(),
  reportMarkdown: z.string().nullable(),
  model: z.string().nullable(),
  error: z.string().nullable(),
});

const zObservation = z.object({
  id: z.number(),
  sessionId: z.string(),
  host: z.string(),
  containerKey: z.string(),
  at: z.string(),
  severity: zAiSeverity,
  title: z.string(),
  detail: z.string(),
  evidence: z.array(z.string()),
  triaged: z.boolean(),
});

const zAlert = z.object({
  id: z.number(),
  at: z.string(),
  severity: zAiSeverity,
  title: z.string(),
  summary: z.string(),
  investigation: z.string().nullable(),
  entities: z.array(z.string()),
  observationIds: z.array(z.number()),
  status: z.enum(['open', 'acknowledged', 'dismissed']),
});

const zAiAnalysisWireMessage = z.object({
  profiles: z.array(zProfile),
  sessions: z.array(zSession),
  observations: z.array(zObservation),
  alerts: z.array(zAlert),
});

function toDate(value: string): Date {
  return new Date(value);
}

function toNullableDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

export const aiAnalysisChannel = defineSseChannel({
  url: '/api/ai-analysis',
  errorEvent: 'ai_analysis_error',
  schema: zAiAnalysisWireMessage,
  revive: (message): AiAnalysisSnapshot => ({
    profiles: message.profiles.map((profile) => ({
      ...profile,
      sampleStartedAt: toNullableDate(profile.sampleStartedAt),
      sampleEndedAt: toNullableDate(profile.sampleEndedAt),
      updatedAt: toDate(profile.updatedAt),
    })),
    sessions: message.sessions.map((session) => ({
      ...session,
      startedAt: toDate(session.startedAt),
      endedAt: toNullableDate(session.endedAt),
    })),
    observations: message.observations.map((observation) => ({
      ...observation,
      at: toDate(observation.at),
    })),
    alerts: message.alerts.map((alert) => ({ ...alert, at: toDate(alert.at) })),
  }),
});

export function serializeAiAnalysisSnapshot(snapshot: AiAnalysisSnapshot): string {
  return `data: ${JSON.stringify(snapshot)}\n\n`;
}
