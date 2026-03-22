import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';
import type { DockerStatsRow } from '@/types/docker';
import { BaseCollector } from './base-collector';

const DOCKER_SOURCE = 'docker';

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

export class AgentStatsCollector extends BaseCollector {
  readonly name: string;
  private readonly host: ManagedHost;
  private readonly fetchFn: FetchFn;
  private knownContainers = new Set<string>();

  constructor(
    db: DatabaseClient,
    config: WorkerConfig,
    host: ManagedHost,
    abortController?: AbortController,
    fetchFn?: FetchFn,
  ) {
    super(db, config, abortController);
    this.host = host;
    this.name = `AgentStatsCollector[${host.name}]`;
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  protected async collect(): Promise<void> {
    const url = `${this.host.agent_url}/stats/stream`;
    this.debugLog(`[${this.name}] Connecting to ${url}`);

    const response = await this.fetchFn(url, {
      headers: {
        Authorization: `Bearer ${this.host.agent_token}`,
      },
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

        // Process complete SSE messages (separated by double newlines)
        const messages = buffer.split('\n\n');
        // Keep the last incomplete chunk in the buffer
        buffer = messages.pop() ?? '';

        for (const message of messages) {
          if (this.signal.aborted) break;
          if (!message.trim()) continue;

          // Extract data from SSE "data: " prefix
          const dataLine = message
            .split('\n')
            .find(line => line.startsWith('data: '));

          if (!dataLine) continue;

          const jsonStr = dataLine.slice(6); // Remove "data: " prefix
          let parsed: unknown;
          try {
            parsed = JSON.parse(jsonStr);
          } catch {
            console.error(`[${this.name}] Failed to parse SSE event: ${jsonStr.substring(0, 100)}`);
            continue;
          }

          if (typeof parsed !== 'object' || parsed === null) continue;

          // Skip error events from the agent
          if ('error' in parsed && !('containerId' in parsed)) continue;

          const event = parsed as AgentStatsEvent;

          // Upsert entity metadata for new containers
          if (!this.knownContainers.has(event.containerId)) {
            try {
              const entityPath = `${this.host.id}/${event.containerId}`;
              await this.repository.upsertEntityMetadata(DOCKER_SOURCE, entityPath, 'name', event.containerName);
              await this.repository.upsertEntityMetadata(DOCKER_SOURCE, entityPath, 'image', event.image);
              // Use container name as service_key (agent doesn't have compose label info yet)
              await this.repository.upsertEntityMetadata(DOCKER_SOURCE, entityPath, 'service_key', event.containerName);
              this.knownContainers.add(event.containerId);
            } catch (err) {
              console.error(
                `[${this.name}] Failed to upsert entity metadata for ${event.containerId}:`,
                err instanceof Error ? err.message : err
              );
              // Don't add to knownContainers so we retry on next event
            }
          }

          // Map agent event to DockerStatsRow
          const row: DockerStatsRow = {
            time: new Date(event.timestamp),
            host: String(this.host.id),
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

          statsReceived++;
          const t0 = performance.now();
          await this.repository.insertDockerStats([row]);
          const writeMs = (performance.now() - t0).toFixed(1);
          this.dbDebugLog(
            `[${this.name}] Wrote stat for ${event.containerName} in ${writeMs}ms (total: ${statsReceived})`
          );
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
