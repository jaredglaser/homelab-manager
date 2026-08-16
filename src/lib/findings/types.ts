import { z } from 'zod';

export const FINDING_SEVERITIES = ['info', 'warning', 'critical'] as const;
export const FINDING_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export const FINDING_SUBJECT_KINDS = ['container', 'stack', 'host'] as const;
export const FINDING_EVIDENCE_KINDS = ['log_line', 'event', 'metric', 'deploy', 'note'] as const;

export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
export type FindingStatus = (typeof FINDING_STATUSES)[number];
export type FindingSubjectKind = (typeof FINDING_SUBJECT_KINDS)[number];
export type FindingEvidenceKind = (typeof FINDING_EVIDENCE_KINDS)[number];
export type FindingSource = 'agent' | 'operator';

export const MAX_TITLE_CHARS = 200;
export const MAX_DETAIL_CHARS = 4000;
export const MAX_RESOLUTION_CHARS = 1000;
export const MAX_EVIDENCE_ITEMS = 10;
export const MAX_EVIDENCE_SOURCE_CHARS = 200;
export const MAX_EVIDENCE_TEXT_CHARS = 2000;
export const MAX_ENTITY_IDS = 50;

export const zFindingFingerprint = z
  .string()
  .min(3)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/, {
    message:
      "Expected a lowercase failure-mode slug such as 'postgres-connection-refused', not a per-occurrence label. Reuse the exact string from a prior finding to update it in place; call list_findings first when unsure.",
  });

export interface FindingEvidence {
  readonly kind: FindingEvidenceKind;
  readonly at: Date | null;
  readonly source: string;
  readonly text: string;
  readonly truncated: boolean;
}

export interface Finding {
  readonly id: number;
  readonly subjectKind: FindingSubjectKind;
  readonly subjectId: string;
  readonly entityIds: string[];
  readonly fingerprint: string;
  readonly severity: FindingSeverity;
  readonly status: FindingStatus;
  readonly title: string;
  readonly detail: string;
  readonly evidence: FindingEvidence[];
  readonly incidentIds: string[];
  readonly runId: string | null;
  readonly source: FindingSource;
  readonly occurrences: number;
  readonly windowFrom: Date | null;
  readonly windowTo: Date | null;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly resolvedAt: Date | null;
  readonly resolution: string | null;
}

export interface FindingEvidenceWire {
  readonly kind: FindingEvidenceKind;
  readonly at: string | null;
  readonly source: string;
  readonly text: string;
  readonly truncated: boolean;
}

export interface FindingWire {
  readonly id: number;
  readonly subjectKind: FindingSubjectKind;
  readonly subjectId: string;
  readonly entityIds: string[];
  readonly fingerprint: string;
  readonly severity: FindingSeverity;
  readonly status: FindingStatus;
  readonly title: string;
  readonly detail: string;
  readonly evidence: FindingEvidenceWire[];
  readonly incidentIds: string[];
  readonly runId: string | null;
  readonly source: FindingSource;
  readonly occurrences: number;
  readonly windowFrom: string | null;
  readonly windowTo: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly resolvedAt: string | null;
  readonly resolution: string | null;
}

export interface RawEvidenceInput {
  readonly kind: FindingEvidenceKind;
  readonly at: string | null;
  readonly source: string;
  readonly text: string;
}

export function toFindingWire(finding: Finding): FindingWire {
  return {
    ...finding,
    windowFrom: finding.windowFrom ? finding.windowFrom.toISOString() : null,
    windowTo: finding.windowTo ? finding.windowTo.toISOString() : null,
    firstSeenAt: finding.firstSeenAt.toISOString(),
    lastSeenAt: finding.lastSeenAt.toISOString(),
    resolvedAt: finding.resolvedAt ? finding.resolvedAt.toISOString() : null,
    evidence: finding.evidence.map((item) => ({
      ...item,
      at: item.at ? item.at.toISOString() : null,
    })),
  };
}

export function reviveFinding(wire: FindingWire): Finding {
  return {
    ...wire,
    windowFrom: wire.windowFrom ? new Date(wire.windowFrom) : null,
    windowTo: wire.windowTo ? new Date(wire.windowTo) : null,
    firstSeenAt: new Date(wire.firstSeenAt),
    lastSeenAt: new Date(wire.lastSeenAt),
    resolvedAt: wire.resolvedAt ? new Date(wire.resolvedAt) : null,
    evidence: wire.evidence.map((item) => ({
      ...item,
      at: item.at ? new Date(item.at) : null,
    })),
  };
}

const ANSI_ESCAPE_PATTERN = new RegExp(
  '[\u001B\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))',
  'g',
);

function stripAnsi(raw: string): string {
  return raw.replace(ANSI_ESCAPE_PATTERN, '');
}

export function sanitizeSingleLine(raw: string, maxChars: number): { text: string; truncated: boolean } {
  const clean = stripAnsi(raw).replace(/[\r\n\t]/g, ' ').trim();
  return { text: clean.slice(0, maxChars), truncated: clean.length > maxChars };
}

export function sanitizeBlock(raw: string, maxChars: number): { text: string; truncated: boolean } {
  const clean = stripAnsi(raw).trim();
  return { text: clean.slice(0, maxChars), truncated: clean.length > maxChars };
}

export function capEvidence(items: readonly RawEvidenceInput[]): {
  evidence: FindingEvidence[];
  dropped: number;
  truncated: number;
} {
  const kept = items.slice(0, MAX_EVIDENCE_ITEMS);
  const dropped = items.length - kept.length;
  let truncated = 0;

  const evidence = kept.map((item) => {
    const { text, truncated: textTruncated } = sanitizeBlock(item.text, MAX_EVIDENCE_TEXT_CHARS);
    if (textTruncated) truncated++;
    const { text: source } = sanitizeSingleLine(item.source, MAX_EVIDENCE_SOURCE_CHARS);
    return {
      kind: item.kind,
      at: item.at ? new Date(item.at) : null,
      source,
      text,
      truncated: textTruncated,
    };
  });

  return { evidence, dropped, truncated };
}
