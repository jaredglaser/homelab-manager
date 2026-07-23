import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import { EntityMetadataRepository } from '@/lib/database/repositories/entity-metadata-repository';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';
import type { NewDockerStat } from '@/lib/database/repositories/stats-repository';
import { BaseCollector } from './base-collector';
import { connectAgentSseStream } from './agent-sse-stream';

/** Shape of SSE events emitted by the agent's GET /stats/stream endpoint */
interface AgentStatsEvent {
  containerId: string;
  containerName: string;
  image: string;
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  memoryPercent: number;
  networkRxBytesPerSec: number;
  networkTxBytesPerSec: number;
  blockReadBytesPerSec: number;
  blockWriteBytesPerSec: number;
  timestamp: string;
}

/** Injectable connector so tests can supply parsed events without opening a byte stream. */
type StreamConnector = typeof connectAgentSseStream;

/**
 * Pending-row flush cadence. TimescaleDB ingest guidance favors multi-row
 * INSERTs over per-row writes; a 50-container host emits 50 events/sec, so
 * batching on a 150 ms window collapses 50 round trips into at most ~7.
 */
const FLUSH_INTERVAL_MS = 150;

/** Return true if the event is an error-only event (no container data) */
function isAgentErrorEvent(event: AgentStatsEvent): boolean {
  return 'error' in event && !('containerId' in event);
}

/** Maps an AgentStatsEvent to a NewDockerStat */
function toNewDockerStat(event: AgentStatsEvent, hostName: string): NewDockerStat {
  return {
    time: new Date(event.timestamp),
    host: hostName,
    containerId: event.containerId,
    containerName: event.containerName,
    image: event.image,
    cpuPercent: event.cpuPercent,
    memoryUsage: event.memoryUsage,
    memoryLimit: event.memoryLimit,
    memoryPercent: event.memoryPercent,
    networkRxBytesPerSec: event.networkRxBytesPerSec,
    networkTxBytesPerSec: event.networkTxBytesPerSec,
    blockReadBytesPerSec: event.blockReadBytesPerSec,
    blockWriteBytesPerSec: event.blockWriteBytesPerSec,
  };
}

export class AgentStatsCollector extends BaseCollector {
  readonly name: string;
  private readonly host: ManagedHost;
  private readonly signer: () => Promise<string>;
  private readonly streamConnector: StreamConnector;
  private readonly entityMetadataRepository: EntityMetadataRepository;
  private readonly knownContainers = new Set<string>();
  private pendingRows: NewDockerStat[] = [];

  constructor(
    db: DatabaseClient,
    config: WorkerConfig,
    host: ManagedHost,
    signer: () => Promise<string>,
    abortController?: AbortController,
    streamConnector?: StreamConnector,
  ) {
    super(db, config, abortController);
    this.host = host;
    this.signer = signer;
    this.name = `AgentStatsCollector[${host.name}]`;
    this.streamConnector = streamConnector ?? connectAgentSseStream;
    this.entityMetadataRepository = new EntityMetadataRepository(db.getPool());
  }

  /** Upsert entity metadata for a newly seen container */
  private async registerContainer(event: AgentStatsEvent): Promise<void> {
    if (this.knownContainers.has(event.containerId)) return;

    try {
      const entityPath = `${this.host.name}/${event.containerId}`;
      await this.entityMetadataRepository.upsertEntityMetadataBatch([
        { entity: entityPath, key: 'name', value: event.containerName },
        { entity: entityPath, key: 'image', value: event.image },
        { entity: entityPath, key: 'service_key', value: event.containerName },
      ]);
      this.knownContainers.add(event.containerId);
    } catch (err) {
      console.error(
        `[${this.name}] Failed to upsert entity metadata for ${event.containerId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  /** Shape and queue a single already-parsed SSE frame, returning true if queued */
  private async processFrame(frame: unknown): Promise<boolean> {
    if (typeof frame !== 'object' || frame === null) return false;
    const event = frame as AgentStatsEvent;

    if (isAgentErrorEvent(event)) return false;

    await this.registerContainer(event);

    this.pendingRows.push(toNewDockerStat(event, this.host.name));
    return true;
  }

  /**
   * Drain pending rows in a single multi-row INSERT. Swaps the buffer before
   * awaiting so rows queued during the write land in the next flush. Errors
   * are logged and the batch dropped so a transient DB failure does not kill
   * the SSE stream; the next interval retries with fresh data.
   */
  private async flushPendingRows(): Promise<void> {
    if (this.pendingRows.length === 0) return;
    const rows = this.pendingRows;
    this.pendingRows = [];

    const t0 = performance.now();
    try {
      await this.repository.insertDockerStats(rows);
    } catch (err) {
      console.error(`[${this.name}] Failed to insert batch of ${rows.length} stats rows:`, err);
      return;
    }
    const writeMs = (performance.now() - t0).toFixed(1);
    this.dbDebugLog(`[${this.name}] Wrote ${rows.length} stats rows in ${writeMs}ms`);
  }

  protected async collect(): Promise<void> {
    this.debugLog(`[${this.name}] Connecting to ${this.host.agentUrl}/stats/stream`);

    const stream = await this.streamConnector({
      agentUrl: this.host.agentUrl,
      path: '/stats/stream',
      signer: this.signer,
      signal: this.signal,
    });

    this.resetBackoff();
    this.debugLog(`[${this.name}] Connected, reading SSE stream`);

    let statsReceived = 0;

    // Interval flush (instead of per-event INSERTs) batches all rows that
    // arrive within the window, regardless of how the agent chunks them.
    const flushTimer = setInterval(() => { void this.flushPendingRows(); }, FLUSH_INTERVAL_MS);

    try {
      for await (const frame of stream) {
        if (this.signal.aborted) break;
        const queued = await this.processFrame(frame);
        if (queued) statsReceived++;
      }
    } finally {
      clearInterval(flushTimer);
      // Final drain so rows queued since the last interval survive stream end
      // and worker shutdown (abort).
      await this.flushPendingRows();
      this.debugLog(
        `[${this.name}] Stream ended (${statsReceived} stats received, aborted=${this.signal.aborted})`
      );
    }
  }
}
