import { ws } from 'msw';

import {
  generateDockerInventorySnapshot,
  generateContainerLogBatch,
  generateContainerLogHistory,
  generateDockerSnapshot,
} from '@/lib/mock/generators/docker';
import { generateZFSSnapshot } from '@/lib/mock/generators/zfs';
import { generateProxmoxSnapshot } from '@/lib/mock/generators/proxmox';
import { generateStackStatusSnapshot } from '@/lib/mock/generators/stacks';
import { loadDemoSettings } from '@/lib/mock/generators/settings';
import { settingsUpdates, stackStatusUpdates } from '@/lib/mock/live-updates';
import { DOCKER_ENTITIES } from '@/lib/mock/entities';
import { parseStatsTopic, type StatsTopicSource } from '@/lib/mux/protocol';

const LOG_INTERVAL_MS = 3000;
const STATS_INTERVAL_MS = 1000;

// Mock drop bursts: every STATS_DROP_EVERY_TICKS ticks a stats feed sheds
// STATS_DROP_COUNT snapshots and summarizes the loss in one dropped frame, so
// the UI gap path is exercisable in dev without a real slow consumer. Per-topic
// phase offsets keep the three feeds from shedding in lockstep.
export const STATS_DROP_EVERY_TICKS = 20;
export const STATS_DROP_COUNT = 2;
const STATS_DROP_PHASE: Record<StatsTopicSource, number> = {
  docker: 0,
  zfs: 7,
  proxmox: 13,
};

interface MuxCommand {
  type?: unknown;
  ref?: unknown;
  topics?: unknown;
}

function eventFrame(topic: string, kind: string, payload: unknown): string {
  return JSON.stringify({ type: 'event', topic, kind, payload });
}

function droppedFrame(topic: string, count: number): string {
  return JSON.stringify({ type: 'event', topic, kind: 'dropped', count });
}

const STATS_SNAPSHOTS: Record<StatsTopicSource, (time: Date) => unknown> = {
  docker: generateDockerSnapshot,
  zfs: generateZFSSnapshot,
  proxmox: generateProxmoxSnapshot,
};

/**
 * Pure per-tick plan for a mock stats feed: the wire frame for this tick, or
 * null when the tick's snapshot is shed as part of a drop burst. Deterministic
 * in (topic, tick) so tests can pin the drop schedule without running timers.
 * Snapshots follow the stats channel wire schemas (epoch-ms `time`, no revive).
 */
export function statsTickFrame(topic: string, tick: number, time: Date): string | null {
  const source = parseStatsTopic(topic);
  if (!source) return null;
  const slot = (tick + STATS_DROP_PHASE[source]) % STATS_DROP_EVERY_TICKS;
  const burstStart = tick - slot;
  // burstStart 0 is the suppressed tick-0 burst: charts open with a real point.
  if (burstStart > 0 && slot < STATS_DROP_COUNT) {
    return slot === 0 ? droppedFrame(topic, STATS_DROP_COUNT) : null;
  }
  return eventFrame(topic, 'data', STATS_SNAPSHOTS[source](time));
}

const mux = ws.link('*/api/mux');

export interface MuxMockClient {
  send(data: string): void;
  addEventListener(type: 'message' | 'close', listener: (event: { data?: unknown }) => void): void;
}

// Event payloads follow the channel wire schemas in src/lib/sse/channels so the mux and
// the retired SSE streams stay shape-identical.
export function createConnectionHandler({ client }: { client: MuxMockClient }): void {
  const topicCleanups = new Map<string, () => void>();
  const stopTopic = (topic: string) => {
    const cleanup = topicCleanups.get(topic);
    if (cleanup !== undefined) {
      topicCleanups.delete(topic);
      cleanup();
    }
  };

  const startTopic = (topic: string) => {
    stopTopic(topic);
    if (topic === 'inventory') {
      client.send(eventFrame(topic, 'data', { type: 'init', containers: generateDockerInventorySnapshot(new Date()) }));
      return;
    }
    if (parseStatsTopic(topic) !== null) {
      // Deltas only, no snapshot on subscribe: the REST preload owns history
      // (gotcha 17), so the first rows arrive on the first poll tick.
      let tick = 0;
      const feedTimer = setInterval(() => {
        const frame = statsTickFrame(topic, tick++, new Date());
        if (frame !== null) client.send(frame);
      }, STATS_INTERVAL_MS);
      topicCleanups.set(topic, () => clearInterval(feedTimer));
      return;
    }
    if (topic === 'settings') {
      topicCleanups.set(topic, settingsUpdates.on((message) => {
        client.send(eventFrame(topic, 'data', message));
      }));
      client.send(eventFrame(topic, 'data', { type: 'init', settings: loadDemoSettings() }));
      return;
    }
    if (topic === 'stack-status') {
      topicCleanups.set(topic, stackStatusUpdates.on((message) => {
        client.send(eventFrame(topic, 'data', message));
      }));
      client.send(eventFrame(topic, 'data', generateStackStatusSnapshot(new Date())));
      return;
    }
    if (!topic.startsWith('logs:')) {
      client.send(eventFrame(topic, 'error', { message: `Unsupported topic: ${topic}`, gone: true }));
      return;
    }
    const key = topic.slice('logs:'.length);
    const slash = key.indexOf('/');
    const host = key.slice(0, slash);
    const containerId = key.slice(slash + 1);
    const entity = DOCKER_ENTITIES.find(
      (e) => e.containerId === containerId && (!host || e.host === host),
    );
    const containerName = entity?.containerName ?? 'unknown';
    // Backlog first so the terminal is not empty on open, then signal completion
    // with the same named event the real agent emits before live tailing.
    client.send(eventFrame(topic, 'backlog_start', {}));
    client.send(eventFrame(topic, 'data', generateContainerLogHistory(containerName, new Date())));
    client.send(eventFrame(topic, 'backlog_done', {}));
    const feedTimer = setInterval(() => {
      client.send(eventFrame(topic, 'data', generateContainerLogBatch(containerName, new Date())));
    }, LOG_INTERVAL_MS);
    topicCleanups.set(topic, () => clearInterval(feedTimer));
  };

  client.addEventListener('message', (event) => {
    let command: MuxCommand;
    try {
      command = JSON.parse(String(event.data)) as MuxCommand;
    } catch {
      return;
    }
    if (command.type !== 'sub' && command.type !== 'unsub') return;
    const topics = Array.isArray(command.topics) ? command.topics.filter((t): t is string => typeof t === 'string') : [];
    const ref = typeof command.ref === 'number' ? command.ref : 0;
    for (const topic of topics) {
      if (command.type === 'sub') startTopic(topic);
      else stopTopic(topic);
    }
    client.send(JSON.stringify({ type: 'ack', ref, ok: true }));
  });

  client.addEventListener('close', () => {
    for (const topic of [...topicCleanups.keys()]) stopTopic(topic);
  });
}

function onConnection({ client }: Parameters<Parameters<typeof mux.addEventListener<'connection'>>[1]>[0]): void {
  createConnectionHandler({ client: client as unknown as MuxMockClient });
}

export const wsHandlers = [mux.addEventListener('connection', onConnection)];
