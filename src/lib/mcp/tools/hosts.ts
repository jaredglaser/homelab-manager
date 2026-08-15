import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpToolContext } from '@/lib/mcp/context';
import {
  zEntityId,
  parseEntityId,
  hasScope,
  iso,
  truncateText,
  encodeCursor,
  decodeCursor,
  McpToolError,
  ok,
  fail,
} from '@/lib/mcp/shared';
import { listContainerSnapshot, getContainerSnapshot, getContainerCountsByHost } from '@/lib/mcp/queries';
import type { ContainerSnapshotRow } from '@/lib/mcp/queries';
import { HostRepository } from '@/lib/database/repositories/host-repository';

const HOSTS_HARD_CAP = 200;
const CONTAINERS_LIMIT_MAX = 200;
const PORTS_MOUNTS_CAP = 20;
const LABEL_OTHER_KEYS_CAP = 20;
const LABEL_VALUE_MAX_CHARS = 200;
const SHORT_CONTAINER_ID_LENGTH = 12;
const COMPOSE_LABEL_PREFIX = 'com.docker.compose.';

const HOSTS_SCOPE = 'mcp:hosts:read';

const hostStatusSchema = z.enum(['pending', 'healthy', 'unhealthy', 'error']);
const containerStateSchema = z.enum(['running', 'exited', 'restarting', 'paused', 'created', 'dead']);

function shortContainerId(containerId: string): string {
  return containerId.length > SHORT_CONTAINER_ID_LENGTH ? containerId.slice(0, SHORT_CONTAINER_ID_LENGTH) : containerId;
}

function toEntityId(host: string, containerId: string): string {
  return `${host}/${shortContainerId(containerId)}`;
}

function registerListHosts(server: McpServer, ctx: McpToolContext): void {
  server.registerTool(
    'list_hosts',
    {
      title: 'List Hosts',
      description:
        "List the managed hosts this deployment monitors. Start here when you do not already know which host a container runs on. A host's `name` is the first segment of every entity id on it (`<host>/<containerId>`), and `capabilities` says whether the host reports Docker containers, ZFS pools, or both. `status` is the monitor's last health verdict for the host agent: when it is not `healthy`, log tools against that host will likely fail while database-backed tools (events, stats) still work. This is small and cheap; call it rather than guessing a host name.",
      inputSchema: {
        capability: z.enum(['docker', 'zfs']).optional(),
      },
      outputSchema: {
        hosts: z.array(
          z.object({
            name: z.string(),
            status: hostStatusSchema,
            capabilities: z.object({ docker: z.boolean(), zfs: z.boolean() }),
            agentVersion: z.string().nullable(),
            agentImageTag: z.string().nullable(),
            containerCount: z.number(),
            addedAt: z.string(),
          }),
        ),
        count: z.number(),
        truncated: z.boolean(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ capability }) => {
      const hostRepo = new HostRepository(ctx.pool);
      const allHosts = await hostRepo.findAll();
      const filtered = capability ? allHosts.filter((h) => Boolean(h.capabilities[capability])) : allHosts;
      const truncated = filtered.length > HOSTS_HARD_CAP;
      const capped = filtered.slice(0, HOSTS_HARD_CAP);

      const countsByHost = await getContainerCountsByHost(ctx.pool);

      const hosts = capped.map((h) => ({
        name: h.name,
        status: h.status,
        capabilities: { docker: Boolean(h.capabilities.docker), zfs: Boolean(h.capabilities.zfs) },
        agentVersion: h.agentVersion,
        agentImageTag: h.agentImageTag,
        containerCount: countsByHost.get(h.name) ?? 0,
        addedAt: iso(h.createdAt),
      }));

      return ok({ hosts, count: hosts.length, truncated });
    },
  );
}

function toContainerListEntry(row: ContainerSnapshotRow) {
  return {
    entityId: toEntityId(row.host, row.containerId),
    host: row.host,
    containerId: shortContainerId(row.containerId),
    name: row.name,
    image: row.image,
    state: row.state,
    stack: row.composeProject,
    service: row.serviceKey,
    startedAt: row.startedAt ? iso(row.startedAt) : null,
    finishedAt: row.finishedAt ? iso(row.finishedAt) : null,
    exitCode: row.exitCode,
    lastEventAt: iso(row.at),
  };
}

function registerListContainers(server: McpServer, ctx: McpToolContext): void {
  server.registerTool(
    'list_containers',
    {
      title: 'List Containers',
      description:
        "List containers the monitor knows about, one row per container carrying its most recent inventory state. Use this to turn a partial name, a compose stack, or a host into the exact `host/containerId` entity ids that every other tool requires; display names collide across hosts and are never accepted as identifiers. Filters combine with AND. Rows are sorted by entity id and capped at `limit`; when `hasMore` is true, pass `nextCursor` back unchanged to continue. This reads the monitor's inventory database rather than the hosts themselves, so it is fast, safe to call repeatedly, and works while a host is offline. It returns no logs and no metrics.",
      inputSchema: {
        host: z.string().min(1).optional(),
        state: containerStateSchema.optional(),
        stack: z.string().min(1).optional(),
        nameContains: z.string().min(1).max(64).optional(),
        limit: z.number().int().min(1).max(CONTAINERS_LIMIT_MAX).default(50),
        cursor: z.string().optional(),
      },
      outputSchema: {
        containers: z.array(
          z.object({
            entityId: z.string(),
            host: z.string(),
            containerId: z.string(),
            name: z.string().nullable(),
            image: z.string().nullable(),
            state: z.string().nullable(),
            stack: z.string().nullable(),
            service: z.string().nullable(),
            startedAt: z.string().nullable(),
            finishedAt: z.string().nullable(),
            exitCode: z.number().nullable(),
            lastEventAt: z.string(),
          }),
        ),
        count: z.number(),
        hasMore: z.boolean(),
        nextCursor: z.string().nullable(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ host, state, stack, nameContains, limit, cursor }) => {
      try {
        const afterEntityId = cursor ? decodeCursor<{ v: number; after: string }>(cursor).after : undefined;

        const rows = await listContainerSnapshot(ctx.pool, {
          host,
          state,
          stack,
          nameContains,
          afterEntityId,
          limit: limit + 1,
        });

        const hasMore = rows.length > limit;
        const containers = rows.slice(0, limit).map(toContainerListEntry);
        const nextCursor =
          hasMore && containers.length > 0
            ? encodeCursor({ after: containers[containers.length - 1]!.entityId })
            : null;

        return ok({ containers, count: containers.length, hasMore, nextCursor });
      } catch (err) {
        if (err instanceof McpToolError) return fail(err);
        throw err;
      }
    },
  );
}

function registerGetContainer(server: McpServer, ctx: McpToolContext): void {
  server.registerTool(
    'get_container',
    {
      title: 'Get Container',
      description:
        "Get everything the monitor knows about one container right now: image, state, exit code, when it started and finished, its compose stack and service, published ports, mounts, and the health of the host it runs on. Call this first when you are handed an entity id, so you know what the container is and whether it is running, restarting, or already dead before you spend tokens on logs. Ports, mounts, and labels are capped; the accompanying counts tell you how many were omitted. Read from the monitor's database, so it answers even when the host agent is unreachable, in which case `host.status` says so.",
      inputSchema: {
        entityId: zEntityId,
        includeLabels: z.boolean().default(true),
      },
      outputSchema: {
        entityId: z.string(),
        host: z.object({
          name: z.string(),
          status: hostStatusSchema,
          agentVersion: z.string().nullable(),
        }),
        container: z.object({
          containerId: z.string(),
          name: z.string().nullable(),
          image: z.string().nullable(),
          state: z.string().nullable(),
          stack: z.string().nullable(),
          service: z.string().nullable(),
          startedAt: z.string().nullable(),
          finishedAt: z.string().nullable(),
          exitCode: z.number().nullable(),
          lastEventAt: z.string(),
          ports: z.array(
            z.object({
              privatePort: z.number(),
              publicPort: z.number().nullable(),
              type: z.string(),
            }),
          ),
          portCount: z.number(),
          mounts: z.array(
            z.object({
              source: z.string(),
              destination: z.string(),
              mode: z.string(),
            }),
          ),
          mountCount: z.number(),
          labels: z.record(z.string(), z.string()),
          labelCount: z.number(),
        }),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ entityId, includeLabels }) => {
      try {
        const { host, containerId } = parseEntityId(entityId);

        const managedHost = await new HostRepository(ctx.pool).findByName(host);
        if (!managedHost) {
          throw new McpToolError('unknown_host', `Unknown host: ${host}`);
        }

        const snapshot = await getContainerSnapshot(ctx.pool, host, containerId);
        if (!snapshot) {
          throw new McpToolError('unknown_container', `No container matching ${entityId} was found.`);
        }
        if (snapshot.eventType === 'destroy') {
          throw new McpToolError(
            'unknown_container',
            `Container ${entityId} was destroyed at ${iso(snapshot.at)}. Call get_container_events for its history.`,
          );
        }

        const ports = snapshot.ports ?? [];
        const mounts = snapshot.mounts ?? [];
        const labels = snapshot.labels ?? {};
        const labelKeys = Object.keys(labels);

        const outputLabels: Record<string, string> = {};
        if (includeLabels) {
          const composeKeys = labelKeys.filter((k) => k.startsWith(COMPOSE_LABEL_PREFIX));
          const otherKeys = labelKeys
            .filter((k) => !k.startsWith(COMPOSE_LABEL_PREFIX))
            .sort()
            .slice(0, LABEL_OTHER_KEYS_CAP);
          for (const key of [...composeKeys, ...otherKeys]) {
            outputLabels[key] = truncateText(labels[key]!, LABEL_VALUE_MAX_CHARS).text;
          }
        }

        return ok({
          entityId: toEntityId(snapshot.host, snapshot.containerId),
          host: { name: managedHost.name, status: managedHost.status, agentVersion: managedHost.agentVersion },
          container: {
            containerId: shortContainerId(snapshot.containerId),
            name: snapshot.name,
            image: snapshot.image,
            state: snapshot.state,
            stack: snapshot.composeProject,
            service: snapshot.serviceKey,
            startedAt: snapshot.startedAt ? iso(snapshot.startedAt) : null,
            finishedAt: snapshot.finishedAt ? iso(snapshot.finishedAt) : null,
            exitCode: snapshot.exitCode,
            lastEventAt: iso(snapshot.at),
            ports: ports.slice(0, PORTS_MOUNTS_CAP).map((p) => ({
              privatePort: p.containerPort,
              publicPort: p.hostPort,
              type: p.protocol,
            })),
            portCount: ports.length,
            mounts: mounts.slice(0, PORTS_MOUNTS_CAP).map((m) => ({
              source: m.source,
              destination: m.destination,
              mode: m.rw ? 'rw' : 'ro',
            })),
            mountCount: mounts.length,
            labels: outputLabels,
            labelCount: labelKeys.length,
          },
        });
      } catch (err) {
        if (err instanceof McpToolError) return fail(err);
        throw err;
      }
    },
  );
}

export function registerHostTools(server: McpServer, ctx: McpToolContext): void {
  if (!hasScope(ctx.scopes, HOSTS_SCOPE)) return;

  registerListHosts(server, ctx);
  registerListContainers(server, ctx);
  registerGetContainer(server, ctx);
}
