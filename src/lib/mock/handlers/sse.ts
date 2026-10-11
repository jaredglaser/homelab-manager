import { http } from 'msw';

import {
  generateDockerSnapshot,
  generateDockerInventorySnapshot,
  generateContainerLogBatch,
  generateContainerLogHistory,
} from '@/lib/mock/generators/docker';
import { generateZFSSnapshot } from '@/lib/mock/generators/zfs';
import { generateProxmoxSnapshot } from '@/lib/mock/generators/proxmox';
import { DOCKER_ENTITIES } from '@/lib/mock/entities';
import { createSseResponse } from '@/lib/mock/handlers/sse-stream';
import * as hostsFns from '@/lib/mock/functions/hosts.functions';

const STATS_INTERVAL_MS = 1000;
const LOG_INTERVAL_MS = 3000;

/** Stream a fresh snapshot immediately, then once per second. */
function statsHandler(generate: () => unknown) {
  return () =>
    createSseResponse((controller) => {
      controller.send(generate());
      controller.interval(STATS_INTERVAL_MS, () => controller.send(generate()));
    });
}

const dockerStats = statsHandler(() => generateDockerSnapshot(new Date()));
const zfsStats = statsHandler(() => generateZFSSnapshot(new Date()));
const proxmoxStats = statsHandler(() => generateProxmoxSnapshot(new Date()));

// Inventory is the Docker table's source of truth: without an initial snapshot the
// page renders no rows even while stats stream fine. Real updates arrive via pg
// NOTIFY, which the demo does not simulate, so we send one init frame and idle.
function dockerInventory() {
  return createSseResponse((controller) => {
    controller.send({ type: 'init', containers: generateDockerInventorySnapshot(new Date()) });
  });
}

// Demo agent inventory: one snapshot frame from the same mixed-status mock set
// the listAgentsInventory server fn returns, then idle (no worker in demo mode).
function agentInventory() {
  return createSseResponse((controller) => {
    void hostsFns.listAgentsInventory().then((entries) => {
      controller.send({ entries, sweptAt: new Date().toISOString() });
    });
  });
}
function dockerLogs(request: Request) {
  const url = new URL(request.url);
  const segments = url.pathname.split('/');
  const containerId = decodeURIComponent(segments[segments.length - 1]);
  const host = url.searchParams.get('host') ?? '';

  const entity = DOCKER_ENTITIES.find(
    (e) => e.containerId === containerId && (!host || e.host === host),
  );
  const containerName = entity?.containerName ?? 'unknown';

  return createSseResponse((controller) => {
    // Backlog first so the terminal is not empty on open, then signal completion
    // with the same named event the real agent emits before live tailing.
    controller.send(generateContainerLogHistory(containerName, new Date()));
    controller.sendEvent('backlog_done', {});
    controller.interval(LOG_INTERVAL_MS, () => {
      controller.send(generateContainerLogBatch(containerName, new Date()));
    });
  });
}

export const sseHandlers = [
  http.get(/\/api\/docker-stats(?:\?|$)/, dockerStats),
  http.get(/\/api\/zfs-stats(?:\?|$)/, zfsStats),
  http.get(/\/api\/proxmox-stats(?:\?|$)/, proxmoxStats),
  http.get(/\/api\/docker-inventory(?:\?|$)/, dockerInventory),
  http.get(/\/api\/agent-inventory(?:\?|$)/, agentInventory),
  http.get(/\/api\/docker-logs\//, ({ request }) => dockerLogs(request)),
];
