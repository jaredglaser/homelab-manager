import {
  readLegacyZfsLineFrame,
  ZFS_HEALTH_EVENT,
  zZfsHealthFrame,
  zZfsStatsFrame,
  type ZfsCapacity,
  type ZfsDevice,
  type ZfsDeviceHealth,
  type ZfsGroup,
  type ZfsIo,
  type ZfsPoolHealth,
  type ZfsStatsFrame,
} from '@homelab-manager/agent/types/protocol';
import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';
import type { NewZFSStat } from '@/lib/database/repositories/stats-repository';
import { ZfsHealthRepository } from '@/lib/database/repositories/zfs-health-repository';
import { zfsEntitySegment, zfsGroupSegment } from '@/lib/utils/zfs-hierarchy-builder';
import type { ZFSEntityType, ZFSNodeHealth, ZFSPoolHealth } from '@/types/zfs';
import { BaseCollector } from './base-collector';
import { AgentSseNamedEvent, connectAgentSseStream } from './agent-sse-stream';

/** Injectable connector so tests can supply parsed events without opening a byte stream. */
type StreamConnector = typeof connectAgentSseStream;

type HealthWriter = Pick<ZfsHealthRepository, 'recordHealth' | 'recordUnreadable' | 'recordDisconnected'>;

export class AgentZfsFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentZfsFrameError';
  }
}

function nodeRow(
  base: { time: Date; host: string; pool: string },
  entity: string,
  entityType: ZFSEntityType,
  depth: number,
  capacity: ZfsCapacity | null,
  io: ZfsIo | null,
): NewZFSStat {
  return {
    ...base,
    entity,
    entityType,
    indent: depth * 2,
    capacityAllocBytes: capacity?.allocBytes ?? null,
    capacityFreeBytes: capacity?.freeBytes ?? null,
    readOpsPerSec: io?.readOps ?? null,
    writeOpsPerSec: io?.writeOps ?? null,
    readBytesPerSec: io?.readBytes ?? null,
    writeBytesPerSec: io?.writeBytes ?? null,
  };
}

/** One row per node. A frame with no pools gets one `host` row, so the host's newest sample still moves on. */
export function zfsFrameToRows(frame: ZfsStatsFrame, host: string): NewZFSStat[] {
  const time = new Date(frame.time);
  if (frame.pools.length === 0) return [nodeRow({ time, host, pool: '' }, '', 'host', 0, null, null)];
  const rows: NewZFSStat[] = [];

  for (const pool of frame.pools) {
    const base = { time, host, pool: pool.name };
    const poolEntity = zfsEntitySegment(pool.name);
    rows.push(nodeRow(base, poolEntity, 'pool', 0, pool.capacity, pool.io));

    const addDevice = (device: ZfsDevice, parent: string, depth: number): void => {
      const entity = `${parent}/${zfsEntitySegment(device.name)}`;
      rows.push(nodeRow(base, entity, device.kind, depth, device.capacity, device.io));
      if (device.kind === 'vdev') {
        for (const child of device.children) addDevice(child, entity, depth + 1);
      }
    };
    const addGroup = (group: ZfsGroup): void => {
      const entity = `${poolEntity}/${zfsGroupSegment(group.group)}`;
      rows.push(nodeRow(base, entity, 'group', 1, null, null));
      for (const child of group.children) addDevice(child, entity, 2);
    };

    for (const child of pool.children) {
      if (child.kind === 'group') addGroup(child);
      else addDevice(child, poolEntity, 1);
    }
  }

  return rows;
}

/** The pool's node first, then its devices with the same entities `zfsFrameToRows` gives them. */
export function poolHealthToRecord(pool: ZfsPoolHealth): ZFSPoolHealth {
  const poolEntity = zfsEntitySegment(pool.name);
  const nodes: ZFSNodeHealth[] = [{ entity: poolEntity, entityType: 'pool', state: pool.state, errors: null }];
  const addDevice = (device: ZfsDeviceHealth, parent: string): void => {
    const entity = `${parent}/${zfsEntitySegment(device.name)}`;
    nodes.push({ entity, entityType: device.kind, state: device.state, errors: device.errors });
    if (device.kind === 'vdev') {
      for (const child of device.children) addDevice(child, entity);
    }
  };
  for (const child of pool.children) {
    if (child.kind !== 'group') {
      addDevice(child, poolEntity);
      continue;
    }
    const entity = `${poolEntity}/${zfsGroupSegment(child.group)}`;
    nodes.push({ entity, entityType: 'group', state: null, errors: null });
    for (const device of child.children) addDevice(device, entity);
  }
  return { pool: pool.name, scan: pool.scan, nodes };
}

/** Stamped with the agent's own clock, like samples, so it orders against the samples of an agent updated later. */
export function agentOutdatedRow(host: string, time: Date): NewZFSStat {
  return nodeRow({ time, host, pool: '' }, '', 'agent_outdated', 0, null, null);
}

/** An old agent sends a frame per line, several a second, and the page needs one marker inside its 90 s window. */
const AGENT_OUTDATED_INTERVAL_MS = 10_000;

export class ZFSCollector extends BaseCollector {
  readonly name: string;
  private readonly host: ManagedHost;
  private readonly signer: () => Promise<string>;
  private readonly streamConnector: StreamConnector;
  private readonly caCertPem: string | null;
  private healthWriter: HealthWriter | undefined;

  constructor(
    db: DatabaseClient,
    config: WorkerConfig,
    host: ManagedHost,
    signer: () => Promise<string>,
    abortController?: AbortController,
    streamConnector?: StreamConnector,
    caCertPem?: string | null,
    healthWriter?: HealthWriter,
  ) {
    super(db, config, abortController);
    this.host = host;
    this.signer = signer;
    this.name = `ZFSCollector[${host.name}]`;
    this.streamConnector = streamConnector ?? connectAgentSseStream;
    this.caCertPem = caCertPem ?? null;
    this.healthWriter = healthWriter;
  }

  private get health(): HealthWriter {
    if (!this.healthWriter) {
      if (!this.db) throw new Error(`${this.name} has no DatabaseClient to build a ZfsHealthRepository from`);
      this.healthWriter = new ZfsHealthRepository(this.db.getPool());
    }
    return this.healthWriter;
  }

  /** Any end of the stream but a stop marks the host offline, so the page shows its last health with when it was seen. */
  protected async collect(): Promise<void> {
    try {
      await this.readStream();
    } finally {
      if (!this.signal.aborted) {
        await this.health.recordDisconnected(this.host.name).catch((err: unknown) => {
          console.error(`[${this.name}] Could not record the agent as offline:`, err);
        });
      }
    }
  }

  /** A health frame off the contract is recorded as unreadable, so a bad health frame cannot stop the stats. */
  private async recordHealth(data: unknown): Promise<void> {
    const parsed = zZfsHealthFrame.safeParse(data);
    if (!parsed.success) {
      console.error(`[${this.name}] The agent sent a ZFS health frame off the contract: ${parsed.error.message}`);
      await this.health.recordUnreadable(this.host.name);
      return;
    }
    if (parsed.data.status === 'unreadable') {
      await this.health.recordUnreadable(this.host.name);
      return;
    }
    await this.health.recordHealth(this.host.name, parsed.data.pools.map(poolHealthToRecord));
  }

  private async readStream(): Promise<void> {
    this.debugLog(`[${this.name}] Connecting to ${this.host.agentUrl}/zfs/stats/stream`);

    const stream = await this.streamConnector({
      agentUrl: this.host.agentUrl,
      path: '/zfs/stats/stream',
      signer: this.signer,
      signal: this.signal,
      caCertPem: this.caCertPem,
      namedEvents: [ZFS_HEALTH_EVENT],
    });

    this.debugLog(`[${this.name}] Connected, reading ZFS stats SSE stream`);

    // Reset only on a frame this worker can read, so an agent sending frames off the contract
    // backs off instead of being reconnected (and its zpool respawned) every second.
    let confirmed = false;
    let lastOutdatedAt: number | null = null;
    try {
      for await (const raw of stream) {
        if (this.signal.aborted) break;

        if (raw instanceof AgentSseNamedEvent) {
          await this.recordHealth(raw.data);
          continue;
        }

        const parsed = zZfsStatsFrame.safeParse(raw);
        if (!parsed.success) {
          const legacy = readLegacyZfsLineFrame(raw);
          if (!legacy) throw new AgentZfsFrameError(`the agent sent a ZFS stats frame off the contract: ${parsed.error.message}`);
          // Kept open rather than thrown into backoff: each reconnect would flash the stale-data alert next to the notice.
          const nowMs = Date.now();
          if (lastOutdatedAt === null || nowMs - lastOutdatedAt >= AGENT_OUTDATED_INTERVAL_MS) {
            if (lastOutdatedAt === null) console.error(`[${this.name}] The agent sends ZFS stats in the format older agents used. Update it.`);
            lastOutdatedAt = nowMs;
            await this.repository.insertZFSStats([agentOutdatedRow(this.host.name, new Date(legacy.timestamp ?? nowMs))]);
          }
          continue;
        }

        if (!confirmed) {
          confirmed = true;
          this.resetBackoff();
        }

        const rows = zfsFrameToRows(parsed.data, this.host.name);
        const t0Write = performance.now();
        await this.repository.insertZFSStats(rows);
        this.dbDebugLog(`[${this.name}] Wrote ${rows.length} ZFS rows in ${(performance.now() - t0Write).toFixed(1)}ms`);
      }
    } finally {
      this.debugLog(`[${this.name}] Stream ended (aborted=${this.signal.aborted})`);
    }
  }
}
