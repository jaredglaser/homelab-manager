import { http } from 'msw';

import {
  generateDockerSnapshot,
  generateDockerInventorySnapshot,
  generateContainerLogBatch,
  generateContainerLogHistory,
} from '@/lib/mock/generators/docker';
import { generateZFSSnapshot } from '@/lib/mock/generators/zfs';
import { generateProxmoxSnapshot } from '@/lib/mock/generators/proxmox';
import { loadDemoSettings } from '@/lib/mock/functions/settings.functions';
import { isViewStateKey } from '@/lib/constants/settings-keys';
import { DOCKER_ENTITIES } from '@/lib/mock/entities';
import type { SettingsSSEMessage } from '@/types/settings';
import { createSseResponse } from '@/lib/mock/handlers/sse-stream';

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

function settings() {
  return createSseResponse((controller) => {
    const stored = loadDemoSettings();
    const config: Record<string, string> = {};
    for (const [key, value] of Object.entries(stored)) {
      if (!isViewStateKey(key)) config[key] = value;
    }
    controller.send({ type: 'init', settings: config } satisfies SettingsSSEMessage);
  });
}

// Stack status has no demo generator yet; open the stream so the hook reports a
// healthy connection (matching the pre-MSW demo) and let the stacks page derive
// state from the listStacks / getStackDetail server functions instead.
function stackStatus() {
  return createSseResponse(() => {
    /* open and idle */
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
  http.get(/\/api\/settings(?:\?|$)/, settings),
  http.get(/\/api\/stack-status(?:\?|$)/, stackStatus),
  http.get(/\/api\/docker-logs\//, ({ request }) => dockerLogs(request)),
];
