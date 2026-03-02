import type { DockerStatsRow } from '@/types/docker';
import { generateMetric, spike } from '../patterns';
import { DOCKER_ENTITIES } from '../entities';

/**
 * Generate a single Docker stats snapshot for a given timestamp.
 * Returns one row per container, matching the `docker_stats` hypertable schema.
 */
export function generateDockerSnapshot(time: Date): DockerStatsRow[] {
  const timeMs = time.getTime();
  const timeStr = time.toISOString();

  return DOCKER_ENTITIES.map((e) => {
    const entityKey = `${e.host}/${e.containerId}`;
    const cpuBase = generateMetric(timeMs, entityKey, 'cpu', e.cpu);
    const cpuSpike = spike(timeMs, entityKey, 'cpu', 600_000, 30_000, 15);
    const memUsage = generateMetric(timeMs, entityKey, 'memUsage', e.memoryUsage);

    return {
      time: timeStr,
      host: e.host,
      container_id: e.containerId,
      container_name: e.containerName,
      image: e.image,
      cpu_percent: Math.round((cpuBase + cpuSpike) * 100) / 100,
      memory_usage: Math.round(memUsage),
      memory_limit: e.memoryLimit,
      memory_percent: Math.round((memUsage / e.memoryLimit) * 10000) / 100,
      network_rx_bytes_per_sec: Math.round(generateMetric(timeMs, entityKey, 'netRx', e.networkRx)),
      network_tx_bytes_per_sec: Math.round(generateMetric(timeMs, entityKey, 'netTx', e.networkTx)),
      block_io_read_bytes_per_sec: Math.round(generateMetric(timeMs, entityKey, 'blockRead', e.blockRead)),
      block_io_write_bytes_per_sec: Math.round(generateMetric(timeMs, entityKey, 'blockWrite', e.blockWrite)),
    };
  });
}

/**
 * Generate `seconds` worth of historical Docker data at 1-second intervals.
 * Rows are ordered oldest-first (ascending time), matching the DB query order.
 */
export function generateDockerHistory(seconds: number): DockerStatsRow[] {
  const now = Date.now();
  const rows: DockerStatsRow[] = [];

  for (let s = seconds; s >= 0; s--) {
    const time = new Date(now - s * 1000);
    rows.push(...generateDockerSnapshot(time));
  }

  return rows;
}

/**
 * Generate history for a specific container (by container_id and optional host).
 * Used by the container history page mock.
 */
export function generateContainerHistory(
  containerId: string,
  host: string | undefined,
  fromMs: number,
  toMs: number,
): DockerStatsRow[] {
  const rows: DockerStatsRow[] = [];
  const entity = DOCKER_ENTITIES.find(
    (e) => e.containerId === containerId && (!host || e.host === host),
  );
  if (!entity) return rows;

  const step = Math.max(1000, Math.floor((toMs - fromMs) / 5000));
  for (let t = fromMs; t <= toMs; t += step) {
    const time = new Date(t);
    const timeMs = time.getTime();
    const entityKey = `${entity.host}/${entity.containerId}`;
    const cpuBase = generateMetric(timeMs, entityKey, 'cpu', entity.cpu);
    const cpuSpike = spike(timeMs, entityKey, 'cpu', 600_000, 30_000, 15);
    const memUsage = generateMetric(timeMs, entityKey, 'memUsage', entity.memoryUsage);

    rows.push({
      time: time.toISOString(),
      host: entity.host,
      container_id: entity.containerId,
      container_name: entity.containerName,
      image: entity.image,
      cpu_percent: Math.round((cpuBase + cpuSpike) * 100) / 100,
      memory_usage: Math.round(memUsage),
      memory_limit: entity.memoryLimit,
      memory_percent: Math.round((memUsage / entity.memoryLimit) * 10000) / 100,
      network_rx_bytes_per_sec: Math.round(generateMetric(timeMs, entityKey, 'netRx', entity.networkRx)),
      network_tx_bytes_per_sec: Math.round(generateMetric(timeMs, entityKey, 'netTx', entity.networkTx)),
      block_io_read_bytes_per_sec: Math.round(generateMetric(timeMs, entityKey, 'blockRead', entity.blockRead)),
      block_io_write_bytes_per_sec: Math.round(generateMetric(timeMs, entityKey, 'blockWrite', entity.blockWrite)),
    });
  }

  return rows;
}
