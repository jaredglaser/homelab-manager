import { createServerFn } from '@tanstack/react-start';
import { authMiddleware } from '@/middleware/auth-middleware';
import { requireRole } from '@/lib/auth/require-role';
import type { AuthUser } from '@/lib/auth/types';
import {
  labelFindingSchema,
  listFindingVerdictsSchema,
  reportMissSchema,
  listReportedMissesSchema,
  setMissStatusSchema,
  reattributeMissSchema,
  getFeedbackMetricsSchema,
} from '@/data/feedback/schemas';
import {
  handleLabelFinding,
  handleListFindingVerdicts,
  handleReportMiss,
  handleSetMissStatus,
  handleReattributeMiss,
  handleGetFeedbackMetrics,
  type FeedbackHandlerDeps,
  type LabelFindingResult,
  type ListVerdictsResult,
  type ReportMissResult,
} from '@/data/feedback/handlers';
import type { ReportedMiss, ReportedMissWire } from '@/lib/feedback/types';
import type { FeedbackMetrics } from '@/lib/feedback/metrics-service';

export type {
  FeedbackHandlerDeps,
  LabelFindingInput,
  LabelFindingResult,
  ListVerdictsInput,
  ListVerdictsResult,
  ReportMissInput,
  ReportMissResult,
  SetMissStatusInput,
  MetricsInput,
} from '@/data/feedback/handlers';

async function loadDeps(): Promise<FeedbackHandlerDeps> {
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { FindingLabelRepository } = await import('@/lib/database/repositories/finding-label-repository');
  const { FindingsRepository } = await import('@/lib/database/repositories/findings-repository');
  const { ReportedMissRepository } = await import('@/lib/database/repositories/reported-miss-repository');
  const { attributeMiss } = await import('@/lib/feedback/attribution');
  const { getFeedbackMetrics: loadFeedbackMetrics } = await import('@/lib/feedback/metrics-service');

  const dbClient = await databaseConnectionManager.getClient(loadDatabaseConfig());
  const pool = dbClient.getPool();

  return {
    labels: new FindingLabelRepository(pool),
    findings: new FindingsRepository(pool),
    misses: new ReportedMissRepository(pool),
    attribute: (input) => attributeMiss(pool, input),
    metrics: (period) => loadFeedbackMetrics(pool, period),
    now: () => new Date(),
  };
}

function actorFor(user: AuthUser | null | undefined): string {
  return user?.email ?? 'unknown';
}

export const labelFinding = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(labelFindingSchema)
  .handler(async ({ data, context }): Promise<LabelFindingResult> => {
    requireRole('admin', 'operator')(context.user);
    const deps = await loadDeps();
    return handleLabelFinding(deps, data, actorFor(context.user));
  });

export const listFindingVerdicts = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(listFindingVerdictsSchema)
  .handler(async ({ data }): Promise<ListVerdictsResult> => {
    const deps = await loadDeps();
    return handleListFindingVerdicts(deps, data);
  });

export const reportMiss = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(reportMissSchema)
  .handler(async ({ data, context }): Promise<ReportMissResult> => {
    requireRole('admin', 'operator')(context.user);
    const deps = await loadDeps();
    return handleReportMiss(deps, data, actorFor(context.user));
  });

export const listReportedMisses = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(listReportedMissesSchema)
  .handler(async ({ data }): Promise<ReportedMiss[]> => {
    const deps = await loadDeps();
    return deps.misses.list({
      status: data.status,
      entityId: data.entityId,
      windowFrom: data.since,
      windowTo: data.until,
      limit: data.limit,
    });
  });

export const setMissStatus = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(setMissStatusSchema)
  .handler(async ({ data, context }): Promise<ReportedMissWire> => {
    requireRole('admin', 'operator')(context.user);
    const deps = await loadDeps();
    return handleSetMissStatus(deps, data);
  });

export const reattributeMiss = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(reattributeMissSchema)
  .handler(async ({ data, context }): Promise<ReportMissResult> => {
    requireRole('admin', 'operator')(context.user);
    const deps = await loadDeps();
    return handleReattributeMiss(deps, data);
  });

export const getFeedbackMetrics = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(getFeedbackMetricsSchema)
  .handler(async ({ data }): Promise<FeedbackMetrics> => {
    const deps = await loadDeps();
    return handleGetFeedbackMetrics(deps, data);
  });
