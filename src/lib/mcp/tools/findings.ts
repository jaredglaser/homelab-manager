import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpToolContext } from '@/lib/mcp/context';
import { zEntityId, zTime, parseEntityId, resolveWindow, hasScope, hasExactScope, iso, truncateText, McpToolError, ok, fail } from '@/lib/mcp/shared';
import { getContainerSnapshot } from '@/lib/mcp/queries';
import { FindingsRepository } from '@/lib/database/repositories/findings-repository';
import type { RecordFindingInput, ListFindingsOptions } from '@/lib/database/repositories/findings-repository';
import {
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  FINDING_SUBJECT_KINDS,
  FINDING_EVIDENCE_KINDS,
  MAX_TITLE_CHARS,
  MAX_DETAIL_CHARS,
  MAX_EVIDENCE_ITEMS,
  MAX_EVIDENCE_SOURCE_CHARS,
  MAX_ENTITY_IDS,
  MAX_RESOLUTION_CHARS,
  zFindingFingerprint,
} from '@/lib/findings/types';
import type { Finding, RawEvidenceInput } from '@/lib/findings/types';

export const FINDINGS_READ_SCOPE = 'mcp:findings:read';
export const FINDINGS_WRITE_SCOPE = 'mcp:findings:write';

const RECORD_DEFAULT_SINCE_SECONDS = 60 * 60;
const RECORD_MAX_SPAN_SECONDS = 30 * 24 * 60 * 60;
const LIST_DEFAULT_SINCE_SECONDS = 30 * 24 * 60 * 60;
const LIST_MAX_SPAN_SECONDS = 365 * 24 * 60 * 60;
const LIST_LIMIT_MAX = 50;
const LIST_LIMIT_MAX_WITH_EVIDENCE = 10;
const LIST_DETAIL_MAX_CHARS = 1000;
const LIST_EVIDENCE_TEXT_MAX_CHARS = 1000;
const EVIDENCE_TEXT_INPUT_MAX_CHARS = 8000;
const INCIDENT_ID_MAX_CHARS = 64;
const RUN_ID_MAX_CHARS = 64;

const findingSeveritySchema = z.enum(FINDING_SEVERITIES);
const findingStatusSchema = z.enum(FINDING_STATUSES);
const findingSubjectKindSchema = z.enum(FINDING_SUBJECT_KINDS);
const findingEvidenceKindSchema = z.enum(FINDING_EVIDENCE_KINDS);

const zEvidenceAt = z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
  message:
    "Expected the ISO 8601 timestamp the line or event carried (2026-08-16T12:00:00Z), as returned by get_logs and get_container_events. Relative durations are not accepted here.",
});

function toEvidenceListEntry(evidence: Finding['evidence'][number], includeEvidence: boolean) {
  if (!includeEvidence) return null;
  const truncated = truncateText(evidence.text, LIST_EVIDENCE_TEXT_MAX_CHARS);
  return {
    kind: evidence.kind,
    at: evidence.at ? iso(evidence.at) : null,
    source: evidence.source,
    text: truncated.text,
    truncated: evidence.truncated || truncated.truncated,
  };
}

function toFindingListEntry(finding: Finding, includeEvidence: boolean) {
  const detail = truncateText(finding.detail, LIST_DETAIL_MAX_CHARS);
  const evidence = includeEvidence
    ? finding.evidence.map((item: Finding['evidence'][number]) => toEvidenceListEntry(item, true)!)
    : [];

  return {
    id: finding.id,
    subjectKind: finding.subjectKind,
    subjectId: finding.subjectId,
    entityIds: [...finding.entityIds],
    fingerprint: finding.fingerprint,
    severity: finding.severity,
    status: finding.status,
    title: finding.title,
    detail: detail.text,
    detailTruncated: detail.truncated,
    evidence,
    evidenceOmitted: !includeEvidence,
    incidentIds: [...finding.incidentIds],
    occurrences: finding.occurrences,
    windowFrom: finding.windowFrom ? iso(finding.windowFrom) : null,
    windowTo: finding.windowTo ? iso(finding.windowTo) : null,
    firstSeenAt: iso(finding.firstSeenAt),
    lastSeenAt: iso(finding.lastSeenAt),
    resolvedAt: finding.resolvedAt ? iso(finding.resolvedAt) : null,
    resolution: finding.resolution,
  };
}

function registerRecordFinding(server: McpServer, ctx: McpToolContext): void {
  server.registerTool(
    'record_finding',
    {
      title: 'Record Finding',
      description: `Record a durable conclusion about a container, stack or host after you have investigated it.

The default outcome of an investigation is NO finding. Most runs end with the logs explaining themselves: a routine restart, a client that hung up, a warning the service prints every hour on the hour. When that is what you found, say so in your reply and call nothing. Recording is the exception, not the closing step.

Record only when all of these hold: something is wrong or degraded right now, you can point at the specific lines or events that show it, and an operator reading it next week would still want to know. Do not record to note that you looked. Do not record to summarise a clean run. Do not record to restate the alert you were handed: a rule firing is the reason you were called, not a conclusion. If you are unsure, do not record. A feed that fills up with observations stops being read, and then the real finding is missed too.

\`fingerprint\` is what makes a recurring fault one finding instead of forty. It names the failure mode, not the occurrence: use \`postgres-connection-refused\`, never \`postgres-connection-refused-2026-08-16\`. Re-recording with the same fingerprint for the same subject updates the existing open finding in place, bumps its occurrence count and refreshes its evidence, instead of filing a duplicate. Reuse the exact string you used before; call \`list_findings\` first when you are not certain what it was. If the earlier finding was already resolved, this files a new one, which is correct: a fault that comes back after being closed is news.

\`evidence\` is what makes the finding checkable by someone who was not here. Cite the two or three log lines, events or numbers that actually convinced you, quoted as they appeared. Do not paste a log dump and do not paraphrase: the text is stored verbatim, stripped of terminal escapes and truncated at 2000 characters per item, and an operator will compare it against the real logs.

Severity is about consequence, not volume: \`critical\` means it is failing or about to, \`warning\` means it is degraded or will be, \`info\` means it is worth knowing and nothing is broken. Reserve \`critical\` for the cases you would want to be woken for.`,
      inputSchema: {
        subjectKind: findingSubjectKindSchema.default('container'),
        subjectId: z.string().min(1).max(512),
        entityIds: z.array(zEntityId).max(MAX_ENTITY_IDS).default([]),
        fingerprint: zFindingFingerprint,
        severity: findingSeveritySchema,
        title: z.string().min(1).max(MAX_TITLE_CHARS),
        detail: z.string().max(MAX_DETAIL_CHARS).default(''),
        evidence: z
          .array(
            z.object({
              kind: findingEvidenceKindSchema.default('log_line'),
              at: zEvidenceAt.optional(),
              source: z.string().max(MAX_EVIDENCE_SOURCE_CHARS).default(''),
              text: z.string().min(1).max(EVIDENCE_TEXT_INPUT_MAX_CHARS),
            }),
          )
          .max(MAX_EVIDENCE_ITEMS)
          .default([]),
        since: zTime.optional(),
        until: zTime.optional(),
        incidentId: z.string().max(INCIDENT_ID_MAX_CHARS).optional(),
        runId: z.string().max(RUN_ID_MAX_CHARS).optional(),
      },
      outputSchema: {
        id: z.number(),
        created: z.boolean(),
        status: findingStatusSchema,
        occurrences: z.number(),
        subjectKind: findingSubjectKindSchema,
        subjectId: z.string(),
        fingerprint: z.string(),
        severity: findingSeveritySchema,
        title: z.string(),
        firstSeenAt: z.string(),
        lastSeenAt: z.string(),
        evidenceStored: z.number(),
        evidenceDropped: z.number(),
        evidenceTruncated: z.number(),
        detailTruncated: z.boolean(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ subjectKind, subjectId, entityIds, fingerprint, severity, title, detail, evidence, since, until, incidentId, runId }) => {
      try {
        let windowFrom: Date | null = null;
        let windowTo: Date | null = null;
        if (since !== undefined || until !== undefined) {
          const window = resolveWindow({ since, until }, { defaultSinceSeconds: RECORD_DEFAULT_SINCE_SECONDS, maxSpanSeconds: RECORD_MAX_SPAN_SECONDS });
          windowFrom = window.from;
          windowTo = window.to;
        }

        let resolvedSubjectId = subjectId;
        if (subjectKind === 'container') {
          if (!zEntityId.safeParse(subjectId).success) {
            throw new McpToolError('unknown_container', `Subject id '${subjectId}' is not a valid container entity id; expected '<host>/<containerId>'.`);
          }
          const { host, containerId } = parseEntityId(subjectId);
          const snapshot = await getContainerSnapshot(ctx.pool, host, containerId);
          if (!snapshot) {
            throw new McpToolError('unknown_container', `No container snapshot found for ${subjectId}.`);
          }
          // containerId may be a short prefix (getContainerSnapshot does a LIKE-prefix match); store the
          // snapshot's own host/containerId so the finding names the container that was actually resolved.
          resolvedSubjectId = `${snapshot.host}/${snapshot.containerId}`;
        } else if (subjectKind === 'stack') {
          if (!subjectId.includes('/')) {
            throw new McpToolError('unknown_stack', `Subject id '${subjectId}' must be of the form '<host>/<stack>'.`);
          }
        }

        const resolvedEntityIds =
          subjectKind === 'container' && !entityIds.includes(resolvedSubjectId) ? [...entityIds, resolvedSubjectId] : entityIds;

        const rawEvidence: RawEvidenceInput[] = evidence.map((item) => ({
          kind: item.kind,
          at: item.at ?? null,
          source: item.source,
          text: item.text,
        }));

        const input: RecordFindingInput = {
          subjectKind,
          subjectId: resolvedSubjectId,
          entityIds: resolvedEntityIds,
          fingerprint,
          severity,
          title,
          detail,
          evidence: rawEvidence,
          incidentId: incidentId ?? null,
          runId: runId ?? null,
          source: 'agent',
          windowFrom,
          windowTo,
          at: new Date(),
        };

        const repo = new FindingsRepository(ctx.pool);
        const result = await repo.record(input);

        return ok({
          id: result.finding.id,
          created: result.created,
          status: result.finding.status,
          occurrences: result.finding.occurrences,
          subjectKind: result.finding.subjectKind,
          subjectId: result.finding.subjectId,
          fingerprint: result.finding.fingerprint,
          severity: result.finding.severity,
          title: result.finding.title,
          firstSeenAt: iso(result.finding.firstSeenAt),
          lastSeenAt: iso(result.finding.lastSeenAt),
          evidenceStored: result.finding.evidence.length,
          evidenceDropped: result.evidenceDropped,
          evidenceTruncated: result.evidenceTruncated,
          detailTruncated: result.detailTruncated,
        });
      } catch (err) {
        if (err instanceof McpToolError) return fail(err);
        throw err;
      }
    },
  );
}

function registerListFindings(server: McpServer, ctx: McpToolContext): void {
  server.registerTool(
    'list_findings',
    {
      title: 'List Findings',
      description: `Show findings already on record, newest activity first. Two uses: check what you concluded about this subject before, and recover the exact \`fingerprint\` of an earlier finding so a recurring fault updates that finding instead of filing a duplicate. Call this before \`record_finding\` whenever the fault might not be the first of its kind.

Defaults to open findings. \`status: "any"\` includes resolved and dismissed ones, which is how you tell "this is new" apart from "this came back after we closed it": a fingerprint that appears on a resolved finding and again on an open one is a recurrence, and worth saying so in your report.

Evidence is omitted by default because it is bulky; pass \`includeEvidence\` when you need to compare what was cited last time against what you are seeing now, and note that doing so caps the result at 10 findings. \`detail\` is truncated in this listing.`,
      inputSchema: {
        subjectId: z.string().max(512).optional(),
        entityId: zEntityId.optional(),
        fingerprint: z.string().max(120).optional(),
        status: z.enum(['open', 'resolved', 'dismissed', 'any']).default('open'),
        severity: findingSeveritySchema.optional(),
        since: zTime.optional(),
        until: zTime.optional(),
        includeEvidence: z.boolean().default(false),
        limit: z.number().int().min(1).max(LIST_LIMIT_MAX).default(20),
      },
      outputSchema: {
        findings: z.array(
          z.object({
            id: z.number(),
            subjectKind: findingSubjectKindSchema,
            subjectId: z.string(),
            entityIds: z.array(z.string()),
            fingerprint: z.string(),
            severity: findingSeveritySchema,
            status: findingStatusSchema,
            title: z.string(),
            detail: z.string(),
            detailTruncated: z.boolean(),
            evidence: z.array(
              z.object({
                kind: findingEvidenceKindSchema,
                at: z.string().nullable(),
                source: z.string(),
                text: z.string(),
                truncated: z.boolean(),
              }),
            ),
            evidenceOmitted: z.boolean(),
            incidentIds: z.array(z.string()),
            occurrences: z.number(),
            windowFrom: z.string().nullable(),
            windowTo: z.string().nullable(),
            firstSeenAt: z.string(),
            lastSeenAt: z.string(),
            resolvedAt: z.string().nullable(),
            resolution: z.string().nullable(),
          }),
        ),
        count: z.number(),
        hasMore: z.boolean(),
        limitClamped: z.boolean(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ subjectId, entityId, fingerprint, status, severity, since, until, includeEvidence, limit }) => {
      try {
        const window = resolveWindow({ since, until }, { defaultSinceSeconds: LIST_DEFAULT_SINCE_SECONDS, maxSpanSeconds: LIST_MAX_SPAN_SECONDS });

        let effectiveLimit = limit;
        let limitClamped = false;
        if (includeEvidence && limit > LIST_LIMIT_MAX_WITH_EVIDENCE) {
          effectiveLimit = LIST_LIMIT_MAX_WITH_EVIDENCE;
          limitClamped = true;
        }

        const options: ListFindingsOptions = {
          subjectId,
          entityId,
          fingerprint,
          status,
          severity,
          since: window.from,
          until: window.to,
          limit: effectiveLimit + 1,
        };

        const repo = new FindingsRepository(ctx.pool);
        const rows = await repo.list(options);
        const hasMore = rows.length > effectiveLimit;
        const findings = rows.slice(0, effectiveLimit).map((finding) => toFindingListEntry(finding, includeEvidence));

        return ok({ findings, count: findings.length, hasMore, limitClamped });
      } catch (err) {
        if (err instanceof McpToolError) return fail(err);
        throw err;
      }
    },
  );
}

function registerResolveFinding(server: McpServer, ctx: McpToolContext): void {
  server.registerTool(
    'resolve_finding',
    {
      title: 'Resolve Finding',
      description: `Close a finding you previously recorded, with a note saying what happened.

Use \`resolved\` when the condition is genuinely over (the container has been healthy since, the deploy was rolled back, the disk was cleared) and say in \`resolution\` what ended it and how you know. Use \`dismissed\` when the finding should not have been filed: it was routine behaviour you misread, a duplicate of another finding, or an artifact of the alert rather than a real fault. Dismissing is how the record gets corrected, so prefer it over leaving something wrong on the feed.

Resolving is not a way to tidy the feed. A finding whose condition is still present stays open, however old it is. Closing it frees its fingerprint, so if the same fault returns it will be filed as a new finding rather than folded into this one, which is what you want for a genuine recurrence and not what you want when the fault never left.`,
      inputSchema: {
        id: z.number().int().positive(),
        status: z.enum(['resolved', 'dismissed']).default('resolved'),
        resolution: z.string().min(1).max(MAX_RESOLUTION_CHARS),
      },
      outputSchema: {
        id: z.number(),
        status: z.enum(['resolved', 'dismissed']),
        resolvedAt: z.string(),
        resolution: z.string(),
        alreadyClosed: z.boolean(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, status, resolution }) => {
      try {
        const repo = new FindingsRepository(ctx.pool);
        const result = await repo.resolve({ id, status, resolution, at: new Date() });
        if (!result) {
          throw new McpToolError('unknown_finding', `No finding with id ${id} was found.`);
        }

        return ok({
          id: result.finding.id,
          status: result.finding.status as 'resolved' | 'dismissed',
          resolvedAt: result.finding.resolvedAt ? iso(result.finding.resolvedAt) : iso(new Date()),
          resolution: result.finding.resolution ?? '',
          alreadyClosed: result.alreadyClosed,
        });
      } catch (err) {
        if (err instanceof McpToolError) return fail(err);
        throw err;
      }
    },
  );
}

export function registerFindingTools(server: McpServer, ctx: McpToolContext): void {
  if (hasScope(ctx.scopes, FINDINGS_READ_SCOPE)) registerListFindings(server, ctx);
  if (hasExactScope(ctx.scopes, FINDINGS_WRITE_SCOPE)) {
    registerRecordFinding(server, ctx);
    registerResolveFinding(server, ctx);
  }
}
