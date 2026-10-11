import { http } from 'msw';

import {
  generateDockerInventorySnapshot,
  generateContainerLogBatch,
  generateContainerLogHistory,
} from '@/lib/mock/generators/docker';
import { DOCKER_ENTITIES } from '@/lib/mock/entities';
import { createSseResponse } from '@/lib/mock/handlers/sse-stream';

const LOG_INTERVAL_MS = 3000;

// Inventory is the Docker table's source of truth: without an initial snapshot the
// page renders no rows even while stats stream fine. Real updates arrive via pg
// NOTIFY, which the demo does not simulate, so we send one init frame and idle.
function dockerInventory() {
  return createSseResponse((controller) => {
    controller.send({ type: 'init', containers: generateDockerInventorySnapshot(new Date()) });
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
  http.get(/\/api\/docker-inventory(?:\?|$)/, dockerInventory),
  http.get(/\/api\/docker-logs\//, ({ request }) => dockerLogs(request)),
];
