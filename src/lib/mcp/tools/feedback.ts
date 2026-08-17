import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpToolContext } from '@/lib/mcp/context';
import { zEntityId, zTime, resolveWindow, hasScope, iso, McpToolError, ok, fail } from '@/lib/mcp/shared';
import { FindingsRepository } from '@/lib/database/repositories/findings-repository';
import type { ListFindingsOptions } from '@/lib/database/repositories/findings-repository';
import { FINDING_SEVERITIES, FINDING_STATUSES } from '@/lib/findings/types';
import type { Finding } from '@/lib/findings/types';
import { OPERATOR_VERDICTS } from '@/lib/feedback/types';
import type { FindingLabel, OperatorVerdict, ReportedMiss } from '@/lib/feedback/types';

export const FEEDBACK_READ_SCOPE = 'mcp:feedback:read';

const DEFAULT_SINCE_SECONDS = 30 * 24 * 60 * 60;
const MAX_SPAN_SECONDS = 365 * 24 * 60 * 60;
const MIN_DECISIVE_LABELS = 20;
const MIN_COVERAGE = 0.5;
const WHAT_HAPPENED_MAX_CHARS = 1000;
const MAX_WEAK_SIGNALS_PER_FINDING = 20;
const MAX_ENTITY_LOOKUPS_FOR_MISSES = 10;

type OperatorVerdictValue = OperatorVerdict;

const findingSeveritySchema = z.enum(FINDING_SEVERITIES);
const findingStatusSchema = z.enum(FINDING_STATUSES);
const operatorVerdictSchema = z.enum(OPERATOR_VERDICTS);
const weakSignalVerdictSchema = z.enum(['actionable', 'noise', 'inconclusive']);

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function pickCurrentLabel(explicitLabels: readonly FindingLabel[]): FindingLabel | null {
  if (explicitLabels.length === 0) return null;
  return [...explicitLabels].sort((a, b) => {
    if (a.source !== b.source) return a.source === 'operator' ? -1 : 1;
    const byTime = b.labeledAt.getTime() - a.labeledAt.getTime();
    if (byTime !== 0) return byTime;
    return b.id - a.id;
  })[0]!;
}

function collectEntityIds(explicitEntityId: string | undefined, findings: readonly Finding[]): string[] {
  if (explicitEntityId) return [explicitEntityId];
  const ids = new Set<string>();
  for (const finding of findings) {
    for (const id of finding.entityIds) ids.add(id);
  }
  return [...ids];
}

interface FeedbackEntry {
  finding: Finding;
  label: FindingLabel | null;
  relabelCount: number;
  weakSignals: FindingLabel[];
}

function toFindingEntry(entry: FeedbackEntry) {
  const { finding, label, relabelCount, weakSignals } = entry;
  return {
    findingId: finding.id,
    fingerprint: finding.fingerprint,
    subjectId: finding.subjectId,
    severity: finding.severity,
    status: finding.status,
    title: finding.title,
    firstSeenAt: iso(finding.firstSeenAt),
    lastSeenAt: iso(finding.lastSeenAt),
    runId: finding.runId,
    verdict: label ? (label.verdict as OperatorVerdictValue) : null,
    verdictSource: label ? (label.source as 'operator' | 'agent') : null,
    verdictAt: label ? iso(label.labeledAt) : null,
    verdictNote: label ? label.note : '',
    duplicateOfFindingId: label ? label.duplicateOfFindingId : null,
    relabelCount,
    weakSignals: weakSignals.map((w) => ({
      signal: w.signal ?? '',
      verdict: w.verdict as 'actionable' | 'noise' | 'inconclusive',
      weight: w.weight,
      confounders: [...w.confounders],
      at: iso(w.labeledAt),
    })),
  };
}

function toReportedMissEntry(row: ReportedMiss) {
  return {
    id: row.id,
    windowFrom: iso(row.windowFrom),
    windowTo: iso(row.windowTo),
    entityIds: [...row.entityIds],
    severity: row.severity,
    whatHappened: truncate(row.whatHappened, WHAT_HAPPENED_MAX_CHARS),
    status: row.status,
    attributionVerdict: row.attributionVerdict,
  };
}

const DESCRIPTION = `Read how your earlier findings were judged. This is your report card: which findings an operator marked actionable, which were called noise, wrong or duplicates, and which are still unlabelled.

Call it at the start of a run on a subject you have investigated before, and before proposing a rule or a route change that leans on your track record for that subject. What happened to your last finding here is the best available evidence about whether to file another one.

Labels come from three places and they are not equal. \`operator\` labels are a human verdict and are the only ones the precision figure is computed from. \`agent\` labels are your own earlier self-corrections. \`weakSignals\` are inferred from what happened after the finding, such as a restart, a redeploy, a rollback, or a container that stayed healthy and untouched for a day. Each weak signal carries a confidence below 0.5 and a list of confounders naming how it could be wrong, and a restart in particular can mean the fault was real, or that an operator read your finding and acted, or that a cron job restarts that container every night. Treat them as a hint about where to look, never as a verdict, and do not repeat one in a report as if a human had said it.

\`precision\` is withheld until there are enough decisive labels for it to mean anything, and \`precisionWithheldReason\` says why when it is null. Four correct findings out of four is not evidence of anything. When it is withheld, quote the raw counts and say the sample is small.

\`reportedMisses\` is the opposite signal and the rarest one: windows where an operator says something broke and nothing was filed. It is the only measurement of what this system fails to catch. If one overlaps the subject or window you are about to investigate, read it before you start.`;

function registerGetFindingFeedback(server: McpServer, ctx: McpToolContext): void {
  server.registerTool(
    'get_finding_feedback',
    {
      title: 'Get Finding Feedback',
      description: DESCRIPTION,
      inputSchema: {
        findingId: z.number().int().positive().optional(),
        subjectId: z.string().max(512).optional(),
        entityId: zEntityId.optional(),
        fingerprint: z.string().max(120).optional(),
        since: zTime.optional(),
        until: zTime.optional(),
        includeUnlabeled: z.boolean().default(true),
        includeWeakSignals: z.boolean().default(true),
        includeMisses: z.boolean().default(true),
        limit: z.number().int().min(1).max(50).default(20),
      },
      outputSchema: {
        findings: z.array(
          z.object({
            findingId: z.number(),
            fingerprint: z.string(),
            subjectId: z.string(),
            severity: findingSeveritySchema,
            status: findingStatusSchema,
            title: z.string(),
            firstSeenAt: z.string(),
            lastSeenAt: z.string(),
            runId: z.string().nullable(),
            verdict: operatorVerdictSchema.nullable(),
            verdictSource: z.enum(['operator', 'agent']).nullable(),
            verdictAt: z.string().nullable(),
            verdictNote: z.string(),
            duplicateOfFindingId: z.number().nullable(),
            relabelCount: z.number(),
            weakSignals: z.array(
              z.object({
                signal: z.string(),
                verdict: weakSignalVerdictSchema,
                weight: z.number(),
                confounders: z.array(z.string()),
                at: z.string(),
              }),
            ),
          }),
        ),
        summary: z.object({
          total: z.number(),
          labeled: z.number(),
          coverage: z.number(),
          counts: z.object({ actionable: z.number(), noise: z.number(), duplicate: z.number(), wrong: z.number() }),
          precision: z.number().nullable(),
          precisionN: z.number(),
          precisionWithheldReason: z.enum(['insufficient_labels', 'insufficient_coverage']).nullable(),
        }),
        reportedMisses: z.array(
          z.object({
            id: z.number(),
            windowFrom: z.string(),
            windowTo: z.string(),
            entityIds: z.array(z.string()),
            severity: findingSeveritySchema,
            whatHappened: z.string(),
            status: z.string(),
            attributionVerdict: z.string().nullable(),
          }),
        ),
        window: z.object({ from: z.string(), to: z.string() }),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ findingId, subjectId, entityId, fingerprint, since, until, includeUnlabeled, includeWeakSignals, includeMisses, limit }) => {
      try {
        if (findingId === undefined && subjectId === undefined && entityId === undefined && fingerprint === undefined) {
          throw new McpToolError('missing_selector', 'At least one of findingId, subjectId, entityId or fingerprint is required.');
        }

        const window = resolveWindow({ since, until }, { defaultSinceSeconds: DEFAULT_SINCE_SECONDS, maxSpanSeconds: MAX_SPAN_SECONDS });

        const { FindingLabelRepository } = await import('@/lib/database/repositories/finding-label-repository');
        const findingsRepo = new FindingsRepository(ctx.pool);
        const labelRepo = new FindingLabelRepository(ctx.pool);

        let matched: Finding[];
        if (findingId !== undefined) {
          const finding = await findingsRepo.getById(findingId);
          matched = finding ? [finding] : [];
        } else {
          const options: ListFindingsOptions = {
            subjectId,
            entityId,
            fingerprint,
            status: 'any',
            since: window.from,
            until: window.to,
            limit,
          };
          matched = await findingsRepo.list(options);
        }

        const total = matched.length;
        const entries: FeedbackEntry[] = [];
        const counts = { actionable: 0, noise: 0, duplicate: 0, wrong: 0 };
        let labeled = 0;

        for (const finding of matched) {
          const rawLabels = await labelRepo.listForFinding(finding.id);
          const explicitLabels = rawLabels.filter((l) => l.source === 'operator' || l.source === 'agent');
          const label = pickCurrentLabel(explicitLabels);
          const weakSignals = includeWeakSignals ? rawLabels.filter((l) => l.source === 'implicit').slice(0, MAX_WEAK_SIGNALS_PER_FINDING) : [];

          if (label) {
            labeled += 1;
            if (label.source === 'operator') counts[label.verdict as OperatorVerdictValue] += 1;
          }

          entries.push({ finding, label, relabelCount: explicitLabels.length > 0 ? explicitLabels.length - 1 : 0, weakSignals });
        }

        const visible = includeUnlabeled ? entries : entries.filter((e) => e.label !== null);
        const bounded = visible.slice(0, limit);

        const decisive = counts.actionable + counts.noise + counts.wrong;
        const coverage = total > 0 ? labeled / total : 0;

        let precision: number | null = null;
        let precisionWithheldReason: 'insufficient_labels' | 'insufficient_coverage' | null = null;
        if (decisive < MIN_DECISIVE_LABELS) {
          precisionWithheldReason = 'insufficient_labels';
        } else if (coverage < MIN_COVERAGE) {
          precisionWithheldReason = 'insufficient_coverage';
        } else {
          precision = counts.actionable / decisive;
        }

        let reportedMisses: ReturnType<typeof toReportedMissEntry>[] = [];
        if (includeMisses) {
          const entityIds = collectEntityIds(entityId, bounded.map((e) => e.finding)).slice(0, MAX_ENTITY_LOOKUPS_FOR_MISSES);
          if (entityIds.length > 0) {
            const { ReportedMissRepository } = await import('@/lib/database/repositories/reported-miss-repository');
            const missRepo = new ReportedMissRepository(ctx.pool);
            const seen = new Set<number>();
            for (const id of entityIds) {
              const rows = await missRepo.list({ entityId: id, windowFrom: window.from, windowTo: window.to, limit });
              for (const row of rows) {
                if (!seen.has(row.id)) {
                  seen.add(row.id);
                  reportedMisses.push(toReportedMissEntry(row));
                }
              }
            }
            reportedMisses = reportedMisses.slice(0, limit);
          }
        }

        return ok({
          findings: bounded.map((e) => toFindingEntry(e)),
          summary: { total, labeled, coverage, counts, precision, precisionN: decisive, precisionWithheldReason },
          reportedMisses,
          window: { from: iso(window.from), to: iso(window.to) },
        });
      } catch (err) {
        if (err instanceof McpToolError) return fail(err);
        throw err;
      }
    },
  );
}

export function registerFeedbackTools(server: McpServer, ctx: McpToolContext): void {
  if (hasScope(ctx.scopes, FEEDBACK_READ_SCOPE)) registerGetFindingFeedback(server, ctx);
}
