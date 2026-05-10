import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import { EntityMetadataRepository } from '@/lib/database/repositories/entity-metadata-repository';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';
import type { DockerStatsRow } from '@/types/docker';
import { BaseCollector } from './base-collector';

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

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Extract the JSON payload from an SSE message, returning null if invalid.
 *  Skips named events (e.g. "event: containers"): only default events carry stats data. */
function extractDataLine(message: string): string | null {
  if (!message.trim()) return null;
  const lines = message.split('\n');
  if (lines.some(line => line.startsWith('event:'))) return null;
  const dataLine = lines.find(line => line.startsWith('data: '));
  return dataLine ? dataLine.slice(6) : null;
}

/** Return true if the event is an error-only event (no container data) */
function isAgentErrorEvent(event: AgentStatsEvent): boolean {
  return 'error' in event && !('containerId' in event);
}

/** Map an AgentStatsEvent to a DockerStatsRow */
function toDockerStatsRow(event: AgentStatsEvent, hostName: string): DockerStatsRow {
  return {
    time: new Date(event.timestamp),
    host: hostName,
    container_id: event.containerId,
    container_name: event.containerName,
    image: event.image,
    cpu_percent: event.cpuPercent,
    memory_usage: event.memoryUsage,
    memory_limit: event.memoryLimit,
    memory_percent: event.memoryPercent,
    network_rx_bytes_per_sec: event.networkRxBytesPerSec,
    network_tx_bytes_per_sec: event.networkTxBytesPerSec,
    block_io_read_bytes_per_sec: event.blockReadBytesPerSec,
    block_io_write_bytes_per_sec: event.blockWriteBytesPerSec,
  };
}

export class AgentStatsCollector extends BaseCollector {
  readonly name: string;
  private readonly host: ManagedHost;
  private readonly signer: () => Promise<string>;
  private readonly fetchFn: FetchFn;
  private readonly entityMetadataRepository: EntityMetadataRepository;
  private readonly knownContainers = new Set<string>();

  constructor(
    db: DatabaseClient,
    config: WorkerConfig,
    host: ManagedHost,
    signer: () => Promise<string>,
    abortController?: AbortController,
    fetchFn?: FetchFn,
  ) {
    super(db, config, abortController);
    this.host = host;
    this.signer = signer;
    this.name = `AgentStatsCollector[${host.name}]`;
    this.fetchFn = fetchFn ?? globalThis.fetch;
    this.entityMetadataRepository = new EntityMetadataRepository(db.getPool());
  }

  /** Upsert entity metadata for a newly seen container */
  private async registerContainer(event: AgentStatsEvent): Promise<void> {
    if (this.knownContainers.has(event.containerId)) return;

    try {
      const entityPath = `${this.host.name}/${event.containerId}`;
      await this.entityMetadataRepository.upsertEntityMetadata(entityPath, 'name', event.containerName);
      await this.entityMetadataRepository.upsertEntityMetadata(entityPath, 'image', event.image);
      await this.entityMetadataRepository.upsertEntityMetadata(entityPath, 'service_key', event.containerName);
      this.knownContainers.add(event.containerId);
    } catch (err) {
      console.error(
        `[${this.name}] Failed to upsert entity metadata for ${event.containerId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  /** Parse and persist a single SSE event, returning true if a stat was written */
  private async processMessage(message: string): Promise<boolean> {
    const jsonStr = extractDataLine(message);
    if (!jsonStr) return false;

    let event: AgentStatsEvent;
    try {
      event = JSON.parse(jsonStr);
    } catch {
      console.error(`[${this.name}] Failed to parse SSE event: ${jsonStr.substring(0, 100)}`);
      return false;
    }

    if (isAgentErrorEvent(event)) return false;

    await this.registerContainer(event);

    const row = toDockerStatsRow(event, this.host.name);
    const t0 = performance.now();
    try {
      await this.repository.insertDockerStats([row]);
    } catch (err) {
      console.error(`[${this.name}] Failed to insert stat for ${event.containerName}:`, err);
      return false;
    }
    const writeMs = (performance.now() - t0).toFixed(1);
    this.dbDebugLog(`[${this.name}] Wrote stat for ${event.containerName} in ${writeMs}ms`);
    return true;
  }

  protected async collect(): Promise<void> {
    const url = `${this.host.agentUrl}/stats/stream`;
    this.debugLog(`[${this.name}] Connecting to ${url}`);

    const response = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${await this.signer()}` },
      signal: this.signal,
    });

    if (!response.ok) {
      throw new Error(`Agent returned ${response.status}: ${response.statusText}`);
    }
    if (!response.body) {
      throw new Error('Agent response has no body');
    }

    this.resetBackoff();
    this.debugLog(`[${this.name}] Connected, reading SSE stream`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let statsReceived = 0;

    try {
      while (!this.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const messages = buffer.split('\n\n');
        buffer = messages.pop() ?? '';

        for (const message of messages) {
          if (this.signal.aborted) break;
          const wrote = await this.processMessage(message);
          if (wrote) statsReceived++;
        }
      }
    } finally {
      reader.releaseLock();
      this.debugLog(
        `[${this.name}] Stream ended (${statsReceived} stats received, aborted=${this.signal.aborted})`
      );
    }
  }
}
