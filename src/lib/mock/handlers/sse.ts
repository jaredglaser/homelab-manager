import { http } from 'msw';

import {
  generateDockerSnapshot,
  generateDockerInventorySnapshot,
  generateContainerLogBatch,
  generateContainerLogHistory,
} from '@/lib/mock/generators/docker';
import { generateZFSSnapshot } from '@/lib/mock/generators/zfs';
import { generateProxmoxSnapshot } from '@/lib/mock/generators/proxmox';
import { generateDefaultSettings } from '@/lib/mock/generators/settings';
import { DEMO_SETTINGS_STORAGE_KEY } from '@/lib/constants/settings-keys';
import { DOCKER_ENTITIES } from '@/lib/mock/entities';
import type { SettingsSSEMessage } from '@/types/settings';
import { createSseResponse } from '@/lib/mock/handlers/sse-stream';

const STATS_INTERVAL_MS = 1000;
const LOG_INTERVAL_MS = 3000;

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}

function loadDemoSettings(): Record<string, string> {
  try {
    const stored = localStorage.getItem(DEMO_SETTINGS_STORAGE_KEY);
    // Hand-edited storage can hold non-object JSON or non-string values; fall
    // back to defaults rather than feeding a malformed shape into the settings atoms.
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (isStringRecord(parsed)) return parsed;
    }
  } catch {
    /* ignore malformed storage */
  }
  return generateDefaultSettings();
}

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
    const message: SettingsSSEMessage = { type: 'init', settings: loadDemoSettings() };
    controller.send(message);
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

// Multiplexed container logs: one stable connection carries every expanded
// row's stream, each frame tagged with its host/containerId key. The client
// POSTs its subscribed keys; the mock tracks them so only those stream.
const muxSubscribedKeys = new Set<string>();

function dockerLogsMuxKey(key: string): { key: string; containerName: string } {
  const slash = key.indexOf('/');
  const host = slash > 0 ? key.slice(0, slash) : '';
  const containerId = slash > 0 ? key.slice(slash + 1) : key;
  const entity = DOCKER_ENTITIES.find(
    (e) => e.containerId === containerId && (!host || e.host === host),
  );
  return { key, containerName: entity?.containerName ?? 'unknown' };
}

function dockerLogsMux() {
  const startedKeys = new Set<string>();
  return createSseResponse((controller) => {
    controller.interval(LOG_INTERVAL_MS, () => {
      for (const key of muxSubscribedKeys) {
        const { containerName } = dockerLogsMuxKey(key);
        if (!startedKeys.has(key)) {
          startedKeys.add(key);
          controller.sendEvent('backlog_start', { key });
          controller.send({ key, lines: generateContainerLogHistory(containerName, new Date()).lines });
          controller.sendEvent('backlog_done', { key });
        } else {
          controller.send({ key, lines: generateContainerLogBatch(containerName, new Date()).lines });
        }
      }
    });
  });
}

function dockerLogsMuxCommand(request: Request) {
  return request.json()
    .then((body) => {
      const command = body as { subscribe?: string[]; unsubscribe?: string[] };
      for (const key of command.subscribe ?? []) {
        muxSubscribedKeys.add(key);
      }
      for (const key of command.unsubscribe ?? []) {
        muxSubscribedKeys.delete(key);
      }
      return new Response(null, { status: 204 });
    })
    .catch(() => new Response('Invalid mux command body', { status: 400 }));
}

export const sseHandlers = [
  http.get(/\/api\/docker-stats(?:\?|$)/, dockerStats),
  http.get(/\/api\/zfs-stats(?:\?|$)/, zfsStats),
  http.get(/\/api\/proxmox-stats(?:\?|$)/, proxmoxStats),
  http.get(/\/api\/docker-inventory(?:\?|$)/, dockerInventory),
  http.get(/\/api\/settings(?:\?|$)/, settings),
  http.get(/\/api\/stack-status(?:\?|$)/, stackStatus),
  http.get(/\/api\/docker-logs-mux(?:\?|$)/, () => dockerLogsMux()),
  http.post(/\/api\/docker-logs-mux(?:\?|$)/, ({ request }) => dockerLogsMuxCommand(request)),
];
