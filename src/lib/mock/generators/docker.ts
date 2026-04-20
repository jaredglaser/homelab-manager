import type { DockerStatsRow } from '@/types/docker';
import type { DockerInventorySnapshotContainer } from '@/types/docker-inventory';
import { generateSimplexMetric, spike } from '@/lib/mock/patterns';
import { DOCKER_ENTITIES, type DockerEntityDef } from '@/lib/mock/entities';
import { mulberry32, hashCode } from '@/lib/mock/prng';

/** Build a single DockerStatsRow from an entity definition at a given time. */
function buildDockerRow(e: DockerEntityDef, timeMs: number, timeStr: string, sampleMs?: number): DockerStatsRow {
  const entityKey = `${e.host}/${e.containerId}`;
  const cpuBase = generateSimplexMetric(timeMs, entityKey, 'cpu', e.cpu, sampleMs);
  // Skip spikes when sample interval is too coarse to represent them -
  // a 30s spike sampled at 518s intervals produces random needles
  const cpuSpike = (!sampleMs || sampleMs <= 30_000)
    ? spike(timeMs, entityKey, 'cpu', 600_000, 30_000, 15)
    : 0;
  const memUsage = generateSimplexMetric(timeMs, entityKey, 'memUsage', e.memoryUsage, sampleMs);

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
    network_rx_bytes_per_sec: Math.round(generateSimplexMetric(timeMs, entityKey, 'netRx', e.networkRx, sampleMs)),
    network_tx_bytes_per_sec: Math.round(generateSimplexMetric(timeMs, entityKey, 'netTx', e.networkTx, sampleMs)),
    block_io_read_bytes_per_sec: Math.round(generateSimplexMetric(timeMs, entityKey, 'blockRead', e.blockRead, sampleMs)),
    block_io_write_bytes_per_sec: Math.round(generateSimplexMetric(timeMs, entityKey, 'blockWrite', e.blockWrite, sampleMs)),
  };
}

/**
 * Generate a single Docker stats snapshot for a given timestamp.
 * Returns one row per container, matching the `docker_stats` hypertable schema.
 */
export function generateDockerSnapshot(time: Date): DockerStatsRow[] {
  const timeMs = time.getTime();
  const timeStr = time.toISOString();
  return DOCKER_ENTITIES.map((e) => buildDockerRow(e, timeMs, timeStr));
}

/**
 * Generate a Docker inventory init snapshot for demo mode.
 *
 * Returns one entry per entity matching `DockerInventorySnapshotContainer`. All containers are
 * `running`; `startedAt`/`updatedAt` are staggered per-entity so deterministic tie-breaking in
 * any downstream dedup path has something to work with. Downstream `JSON.stringify` serializes
 * the `Date` fields to ISO strings, matching the real broadcast wire format.
 */
export function generateDockerInventorySnapshot(now: Date): DockerInventorySnapshotContainer[] {
  const nowMs = now.getTime();
  return DOCKER_ENTITIES.map((e, idx) => {
    const startedAt = new Date(nowMs - (idx + 1) * 60_000);
    return {
      host: e.host,
      containerId: e.containerId,
      name: e.containerName,
      image: e.image,
      state: 'running',
      composeProject: null,
      serviceKey: e.serviceKey,
      startedAt,
      finishedAt: null,
      exitCode: null,
      labels: {},
      updatedAt: startedAt,
    };
  });
}

/**
 * Generate `seconds` worth of historical Docker data at 1-second intervals.
 * Rows are ordered oldest-first (ascending time), matching the DB query order.
 */
export function generateDockerHistory(seconds: number): DockerStatsRow[] {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const now = Date.now();
  const rows: DockerStatsRow[] = [];

  for (let i = s; i >= 0; i--) {
    const time = new Date(now - i * 1000);
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
  targetPoints: number = 300,
): DockerStatsRow[] {
  const rows: DockerStatsRow[] = [];
  const entity = DOCKER_ENTITIES.find(
    (e) => e.containerId === containerId && (!host || e.host === host),
  );
  if (!entity) return rows;

  const spanMs = toMs - fromMs;
  const step = Math.max(1000, Math.floor(spanMs / targetPoints));
  for (let t = fromMs; t <= toMs; t += step) {
    const time = new Date(t);
    rows.push(buildDockerRow(entity, time.getTime(), time.toISOString(), step));
  }

  return rows;
}

// ─── Mock Container Log Generation ──────────────────────────────────────────

/** Log line in the same shape the SSE docker-logs endpoint emits. */
export interface MockLogLine {
  text: string;
  stream: 'stdout' | 'stderr';
}

/** Per-service log templates. Each entry is [stream, template]. */
const LOG_TEMPLATES: Record<string, [MockLogLine['stream'], string][]> = {
  'nginx-proxy': [
    ['stdout', '192.168.1.{ip} - - [{ts}] "GET /api/health HTTP/1.1" 200 15 "-" "kube-probe/1.28"'],
    ['stdout', '192.168.1.{ip} - - [{ts}] "GET / HTTP/1.1" 200 612 "-" "Mozilla/5.0"'],
    ['stdout', '192.168.1.{ip} - - [{ts}] "POST /api/data HTTP/1.1" 201 284 "-" "axios/1.6"'],
    ['stderr', '{ts} [warn] 1#1: *{n} upstream timed out (110: Connection timed out)'],
    ['stdout', '192.168.1.{ip} - - [{ts}] "GET /favicon.ico HTTP/1.1" 304 0 "-" "Mozilla/5.0"'],
  ],
  plex: [
    ['stdout', '[{ts}] INFO - Now streaming: Movie #{n} to client 192.168.1.{ip}'],
    ['stdout', '[{ts}] INFO - Metadata refresh completed for library "Movies"'],
    ['stdout', '[{ts}] DEBUG - Transcoder: segment {n} ready, bitrate 8000kbps'],
    ['stdout', '[{ts}] INFO - Session {sess}: playback started by user admin'],
    ['stderr', '[{ts}] WARN - Scanner: unable to find match for "Unknown Media {n}"'],
  ],
  homeassistant: [
    ['stdout', '{ts} INFO (MainThread) [homeassistant.core] Bus:Handling <Event state_changed>'],
    ['stdout', '{ts} INFO (MainThread) [homeassistant.components.sensor] Updating sensor.temperature_{n}'],
    ['stdout', '{ts} DEBUG (MainThread) [homeassistant.components.mqtt] Received message on topic home/sensor/{n}'],
    ['stderr', '{ts} WARNING (MainThread) [homeassistant.components.zwave] Node {n}: not ready after 30s'],
    ['stdout', '{ts} INFO (MainThread) [homeassistant.components.automation] Triggered automation "Night Mode"'],
  ],
  postgres: [
    ['stdout', '{ts} UTC [1] LOG:  checkpoint starting: time'],
    ['stdout', '{ts} UTC [1] LOG:  checkpoint complete: wrote {n} buffers (0.1%)'],
    ['stdout', '{ts} UTC [{n}] LOG:  duration: {dur}ms  statement: SELECT * FROM docker_stats'],
    ['stderr', '{ts} UTC [{n}] WARNING:  worker process {n} (PID {pid}) was terminated by signal 9'],
    ['stdout', '{ts} UTC [1] LOG:  automatic vacuum of table "homelab.public.docker_stats"'],
  ],
  grafana: [
    ['stdout', 't={ts} lvl=info msg="Request Completed" method=GET path=/api/dashboards status=200 duration={dur}ms'],
    ['stdout', 't={ts} lvl=info msg="Executing query" datasource=TimescaleDB queryType=time_series'],
    ['stdout', 't={ts} lvl=info msg="Dashboard rendered" uid=homelab-docker panels=6'],
    ['stderr', 't={ts} lvl=warn msg="Slow query" datasource=TimescaleDB duration={dur}ms'],
    ['stdout', 't={ts} lvl=info msg="API request" method=GET path=/api/health status=200'],
  ],
  traefik: [
    ['stdout', '{ip} - - [{ts}] "GET / HTTP/2.0" 200 {n} "https://homelab.local" 1ms'],
    ['stdout', '{ip} - - [{ts}] "GET /api/health HTTP/1.1" 200 2 "-" 0ms'],
    ['stdout', 'time="{ts}" level=debug msg="Service selected" service=plex@docker'],
    ['stderr', 'time="{ts}" level=warning msg="TLS handshake error" client=192.168.1.{ip}'],
    ['stdout', 'time="{ts}" level=info msg="Configuration received" provider=docker'],
  ],
  jellyfin: [
    ['stdout', '[{ts}] [INF] User admin playing Movie #{n}'],
    ['stdout', '[{ts}] [INF] Transcode: starting h264 → h264 for session {sess}'],
    ['stdout', '[{ts}] [INF] Library scan complete: 1247 items in "Movies"'],
    ['stderr', '[{ts}] [WRN] Failed to fetch metadata for item {n}: timeout'],
    ['stdout', '[{ts}] [INF] HTTP Response 200 to 192.168.1.{ip} in {dur}ms'],
  ],
  vaultwarden: [
    ['stdout', '[{ts}][INFO] POST /api/sync 200 {dur}ms'],
    ['stdout', '[{ts}][INFO] GET /api/ciphers 200 {dur}ms'],
    ['stdout', '[{ts}][INFO] Cipher updated for user admin@homelab.local'],
    ['stdout', '[{ts}][INFO] WebSocket connection established for user admin'],
    ['stderr', '[{ts}][WARN] Failed login attempt from 192.168.1.{ip}'],
  ],
  pihole: [
    ['stdout', '[{ts}] query[A] ads.example.com from 192.168.1.{ip}'],
    ['stdout', '[{ts}] gravity blocked ads.example.com is 0.0.0.0'],
    ['stdout', '[{ts}] query[AAAA] github.com from 192.168.1.{ip}'],
    ['stdout', '[{ts}] forwarded github.com to 1.1.1.1'],
    ['stderr', '[{ts}] dnsmasq[1]: failed to allocate {n} bytes'],
  ],
  portainer: [
    ['stdout', '{ts} INFO http/handler: GET /api/endpoints 200 {dur}ms'],
    ['stdout', '{ts} INFO http/handler: GET /api/stacks 200 {dur}ms'],
    ['stdout', '{ts} INFO docker/client: container list refreshed ({n} containers)'],
    ['stdout', '{ts} INFO scheduler: snapshot job completed in {dur}ms'],
    ['stderr', '{ts} WARN docker/client: endpoint health check failed for 192.168.1.{ip}'],
  ],
};

/** Fallback templates for unknown containers. */
const DEFAULT_LOG_TEMPLATES: [MockLogLine['stream'], string][] = [
  ['stdout', '[{ts}] INFO  Service running normally'],
  ['stdout', '[{ts}] DEBUG Request processed in {dur}ms'],
  ['stdout', '[{ts}] INFO  Health check passed'],
  ['stderr', '[{ts}] WARN  High memory usage detected'],
  ['stdout', '[{ts}] INFO  Connection from 192.168.1.{ip}'],
];

/** Fill template placeholders with deterministic values. */
function fillTemplate(template: string, rng: () => number, time: Date): string {
  const ts = time.toISOString().replace('T', ' ').replace('Z', '');
  return template
    .replace(/\{ts\}/g, ts)
    .replace(/\{ip\}/g, String(Math.floor(rng() * 200) + 2))
    .replace(/\{n\}/g, String(Math.floor(rng() * 9000) + 1000))
    .replace(/\{dur\}/g, String(Math.floor(rng() * 500) + 1))
    .replace(/\{pid\}/g, String(Math.floor(rng() * 30000) + 1000))
    .replace(/\{sess\}/g, Math.floor(rng() * 0xffffff).toString(16));
}

/**
 * Generate a backlog of mock log lines for a container, simulating recent history.
 * Produces logs spanning `buckets` × 3-second intervals leading up to `time`.
 * Used in demo mode to fill the terminal immediately on open.
 */
export function generateContainerLogHistory(
  containerName: string,
  time: Date,
  buckets: number = 20,
): { lines: MockLogLine[] } {
  const lines: MockLogLine[] = [];
  const timeMs = time.getTime();

  for (let i = buckets - 1; i >= 0; i--) {
    const bucketTime = new Date(timeMs - i * 3000);
    const batch = generateContainerLogBatch(containerName, bucketTime);
    lines.push(...batch.lines);
  }

  return { lines };
}

/**
 * Generate a batch of mock log lines for a container.
 * Returns 1-4 lines per call, weighted toward stdout with occasional stderr.
 * Deterministic for the same containerName + time bucket.
 */
export function generateContainerLogBatch(
  containerName: string,
  time: Date,
): { lines: MockLogLine[] } {
  const timeMs = time.getTime();
  const bucket = Math.floor(timeMs / 3000); // 3-second buckets
  const seed = hashCode(`${containerName}/logs/${bucket}`);
  const rng = mulberry32(seed);

  const templates = LOG_TEMPLATES[containerName] ?? DEFAULT_LOG_TEMPLATES;
  const lineCount = Math.floor(rng() * 4) + 1;
  const lines: MockLogLine[] = [];

  for (let i = 0; i < lineCount; i++) {
    const templateIdx = Math.floor(rng() * templates.length);
    const [stream, template] = templates[templateIdx];
    // Offset each line by a few ms for realism
    const lineTime = new Date(timeMs + i * Math.floor(rng() * 200));
    lines.push({ text: fillTemplate(template, rng, lineTime), stream });
  }

  return { lines };
}
