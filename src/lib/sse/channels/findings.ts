import { z } from 'zod';
import { defineSseChannel } from '@/lib/sse/define-sse-channel';
import type { SseChannelDescriptor } from '@/lib/sse/define-sse-channel';
import {
  FINDING_EVIDENCE_KINDS,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  FINDING_SUBJECT_KINDS,
  reviveFinding,
  toFindingWire,
} from '@/lib/findings/types';
import type { Finding, FindingEvidenceWire, FindingWire } from '@/lib/findings/types';
import type { FindingsBroadcastEvent } from '@/lib/findings/findings-broadcast-service';

export const zFindingEvidenceWire: z.ZodType<FindingEvidenceWire> = z.object({
  kind: z.enum(FINDING_EVIDENCE_KINDS),
  at: z.string().nullable(),
  source: z.string(),
  text: z.string(),
  truncated: z.boolean(),
});

export const zFindingWire: z.ZodType<FindingWire> = z.object({
  id: z.number(),
  subjectKind: z.enum(FINDING_SUBJECT_KINDS),
  subjectId: z.string(),
  entityIds: z.array(z.string()),
  fingerprint: z.string(),
  severity: z.enum(FINDING_SEVERITIES),
  status: z.enum(FINDING_STATUSES),
  title: z.string(),
  detail: z.string(),
  evidence: z.array(zFindingEvidenceWire),
  incidentIds: z.array(z.string()),
  runId: z.string().nullable(),
  source: z.enum(['agent', 'operator']),
  occurrences: z.number(),
  windowFrom: z.string().nullable(),
  windowTo: z.string().nullable(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  resolvedAt: z.string().nullable(),
  resolution: z.string().nullable(),
});

export type FindingsWireMessage =
  | { type: 'init'; findings: FindingWire[] }
  | { type: 'upsert'; finding: FindingWire };

export const zFindingsWireMessage: z.ZodType<FindingsWireMessage> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('init'), findings: z.array(zFindingWire) }),
  z.object({ type: z.literal('upsert'), finding: zFindingWire }),
]);

export type FindingsSSEMessage =
  | { type: 'init'; findings: Finding[] }
  | { type: 'upsert'; finding: Finding };

export const findingsChannel: SseChannelDescriptor<typeof zFindingsWireMessage, FindingsSSEMessage> = defineSseChannel({
  url: '/api/findings',
  errorEvent: 'findings_error',
  schema: zFindingsWireMessage,
  revive: (message): FindingsSSEMessage =>
    message.type === 'init'
      ? { type: 'init', findings: message.findings.map(reviveFinding) }
      : { type: 'upsert', finding: reviveFinding(message.finding) },
});

export function serializeFindingsEvent(event: FindingsBroadcastEvent): string {
  if (event.type === 'init') {
    return `data: ${JSON.stringify({ type: 'init', findings: event.findings.map(toFindingWire) })}\n\n`;
  }
  return `data: ${JSON.stringify({ type: 'upsert', finding: toFindingWire(event.finding) })}\n\n`;
}
