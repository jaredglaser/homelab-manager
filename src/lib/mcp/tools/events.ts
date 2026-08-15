import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpToolContext } from '@/lib/mcp/context';
import { zEntityId, zTime, parseEntityId, resolveWindow, hasScope, iso, truncateText, McpToolError, ok, fail } from '@/lib/mcp/shared';
import { getContainerEvents, getContainerSnapshot, getDeployHistoryForStack } from '@/lib/mcp/queries';
import type { ContainerEventRow } from '@/lib/mcp/queries';
import { DeployRepository } from '@/lib/database/repositories/deploy-repository';
import { DEPLOY_ACTION_VALUES, DEPLOY_STATUS_VALUES, DEPLOY_TRIGGER_VALUES } from '@/lib/deploy/types';
import type { DeployRecord } from '@/lib/deploy/types';

const EVENTS_SCOPE = 'mcp:events:read';
const CONTAINER_EVENTS_LIMIT_MAX = 200;
const DEPLOY_HISTORY_LIMIT_MAX = 50;
const DEPLOY_LOGS_MAX_CHARS = 8000;
const CONTAINER_EVENTS_DEFAULT_SINCE_SECONDS = 24 * 60 * 60;
const CONTAINER_EVENTS_MAX_SPAN_SECONDS = 90 * 24 * 60 * 60;

const deployStatusSchema = z.enum(DEPLOY_STATUS_VALUES);
const deployTriggerSchema = z.enum(DEPLOY_TRIGGER_VALUES);
const deployActionSchema = z.enum(DEPLOY_ACTION_VALUES);

function toContainerEventEntry(row: ContainerEventRow) {
  if (row.eventType === 'destroy') {
    return {
      at: iso(row.at),
      eventType: 'destroy' as const,
      state: null,
      name: null,
      image: null,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      stack: null,
      service: null,
    };
  }

  return {
    at: iso(row.at),
    eventType: 'upsert' as const,
    state: row.state,
    name: row.name,
    image: row.image,
    startedAt: row.startedAt ? iso(row.startedAt) : null,
    finishedAt: row.finishedAt ? iso(row.finishedAt) : null,
    exitCode: row.exitCode,
    stack: row.composeProject,
    service: row.serviceKey,
  };
}

function registerGetContainerEvents(server: McpServer, ctx: McpToolContext): void {
  server.registerTool(
    'get_container_events',
    {
      title: 'Get Container Events',
      description:
        "Show the lifecycle changes the monitor recorded for one container in a time window: transitions between running, restarting, exited, paused and dead, image changes, and destruction. This is how you answer \"did it restart, and when\". Each row is the container's state as of `at`; `exitCode` on a transition into `exited` is the process exit status, and a changing `image` between rows means the container was replaced by a deploy. Rows are newest first. This reads the monitor's append-only event log rather than the host, so it still answers for a container that no longer exists or a host that is offline.",
      inputSchema: {
        entityId: zEntityId,
        since: zTime.optional(),
        until: zTime.optional(),
        limit: z.number().int().min(1).max(CONTAINER_EVENTS_LIMIT_MAX).default(50),
      },
      outputSchema: {
        entityId: z.string(),
        window: z.object({ from: z.string(), to: z.string() }),
        events: z.array(
          z.object({
            at: z.string(),
            eventType: z.enum(['upsert', 'destroy']),
            state: z.string().nullable(),
            name: z.string().nullable(),
            image: z.string().nullable(),
            startedAt: z.string().nullable(),
            finishedAt: z.string().nullable(),
            exitCode: z.number().nullable(),
            stack: z.string().nullable(),
            service: z.string().nullable(),
          }),
        ),
        count: z.number(),
        hasMore: z.boolean(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ entityId, since, until, limit }) => {
      try {
        const { host, containerId } = parseEntityId(entityId);
        const window = resolveWindow(
          { since, until },
          { defaultSinceSeconds: CONTAINER_EVENTS_DEFAULT_SINCE_SECONDS, maxSpanSeconds: CONTAINER_EVENTS_MAX_SPAN_SECONDS },
        );

        const rows = await getContainerEvents(ctx.pool, host, containerId, window.from, window.to, limit + 1);
        const hasMore = rows.length > limit;
        const events = rows.slice(0, limit).map(toContainerEventEntry);

        return ok({
          entityId,
          window: { from: iso(window.from), to: iso(window.to) },
          events,
          count: events.length,
          hasMore,
        });
      } catch (err) {
        if (err instanceof McpToolError) return fail(err);
        throw err;
      }
    },
  );
}

function toDeployEntry(record: DeployRecord, includeLogs: boolean) {
  let logs: string | null = null;
  let logsTruncated = false;
  if (includeLogs && record.logs !== null) {
    const truncated = truncateText(record.logs, DEPLOY_LOGS_MAX_CHARS);
    logs = truncated.text;
    logsTruncated = truncated.truncated;
  }

  return {
    id: record.id,
    stack: record.stack,
    host: record.host,
    commitSha: record.commitSha,
    status: record.status,
    trigger: record.trigger,
    action: record.action,
    forceRecreate: record.forceRecreate,
    composeHash: record.composeHash,
    envHash: record.envHash,
    createdAt: iso(record.createdAt),
    logsOmitted: !includeLogs,
    logs,
    logsTruncated,
  };
}

function registerGetDeployHistory(server: McpServer, ctx: McpToolContext): void {
  server.registerTool(
    'get_deploy_history',
    {
      title: 'Get Deploy History',
      description:
        'Show recent deploys of a stack, newest first: commit sha, trigger (git push, UI, or rollback), action, status, and when it ran. This is how you answer "did anything change" when a container starts failing. Identify the stack either by passing a container\'s entity id, which resolves to the stack that container belongs to, or by naming the stack directly. Deploy output is omitted by default because it is long; when one run looks relevant, call again with `deployId` and `includeLogs` to read just that run\'s output. Pair a suspicious `commitSha` with `get_stack_compose` to see exactly what the deploy changed.',
      inputSchema: {
        entityId: zEntityId.optional(),
        stack: z.string().min(1).optional(),
        host: z.string().min(1).optional(),
        deployId: z.number().int().positive().optional(),
        includeLogs: z.boolean().default(false),
        limit: z.number().int().min(1).max(DEPLOY_HISTORY_LIMIT_MAX).default(10),
      },
      outputSchema: {
        stack: z.string(),
        host: z.string().nullable(),
        deploys: z.array(
          z.object({
            id: z.number(),
            stack: z.string(),
            host: z.string(),
            commitSha: z.string(),
            status: deployStatusSchema,
            trigger: deployTriggerSchema,
            action: deployActionSchema,
            forceRecreate: z.boolean(),
            composeHash: z.string(),
            envHash: z.string(),
            createdAt: z.string(),
            logsOmitted: z.boolean(),
            logs: z.string().nullable(),
            logsTruncated: z.boolean(),
          }),
        ),
        count: z.number(),
        hasMore: z.boolean(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ entityId, stack, host, deployId, includeLogs, limit }) => {
      try {
        const providedCount = [entityId, stack, deployId].filter((v) => v !== undefined).length;
        if (providedCount !== 1) {
          throw new McpToolError('unknown_stack', 'Provide exactly one of entityId, stack, or deployId.');
        }

        if (deployId !== undefined) {
          const record = await new DeployRepository(ctx.pool).getById(deployId);
          if (!record) {
            throw new McpToolError('unknown_stack', `No deploy record with id ${deployId} was found.`);
          }
          return ok({
            stack: record.stack,
            host: record.host,
            deploys: [toDeployEntry(record, includeLogs)],
            count: 1,
            hasMore: false,
          });
        }

        let resolvedStack: string;
        let resolvedHost: string | null;

        if (entityId !== undefined) {
          const { host: entityHost, containerId } = parseEntityId(entityId);
          const snapshot = await getContainerSnapshot(ctx.pool, entityHost, containerId);
          if (!snapshot || snapshot.eventType !== 'upsert' || !snapshot.composeProject) {
            throw new McpToolError('unknown_stack', `Container ${entityId} is not part of a managed stack.`);
          }
          resolvedStack = snapshot.composeProject;
          resolvedHost = entityHost;
        } else {
          resolvedStack = stack!;
          resolvedHost = host ?? null;
        }

        const records = await getDeployHistoryForStack(ctx.pool, resolvedStack, resolvedHost, limit + 1);
        const hasMore = records.length > limit;
        const deploys = records.slice(0, limit).map((record) => toDeployEntry(record, false));

        return ok({
          stack: resolvedStack,
          host: resolvedHost,
          deploys,
          count: deploys.length,
          hasMore,
        });
      } catch (err) {
        if (err instanceof McpToolError) return fail(err);
        throw err;
      }
    },
  );
}

export function registerEventTools(server: McpServer, ctx: McpToolContext): void {
  if (!hasScope(ctx.scopes, EVENTS_SCOPE)) return;

  registerGetContainerEvents(server, ctx);
  registerGetDeployHistory(server, ctx);
}
