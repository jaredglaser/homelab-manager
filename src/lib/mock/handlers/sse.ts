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
import { generateAiSnapshot } from '@/lib/mock/generators/ai';
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

// The real channel re-sends the whole snapshot on every write; the demo has no
// worker filing observations, so it sends the fixture once and idles.
function aiAnalysis() {
  return createSseResponse((controller) => {
    controller.send(generateAiSnapshot());
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
  http.get(/\/api\/ai-analysis(?:\?|$)/, aiAnalysis),
  http.get(/\/api\/docker-logs\//, ({ request }) => dockerLogs(request)),
];
