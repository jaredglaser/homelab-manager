import { ws } from 'msw';

import {
  generateDockerInventorySnapshot,
  generateContainerLogBatch,
  generateContainerLogHistory,
} from '@/lib/mock/generators/docker';
import { generateStackStatusSnapshot } from '@/lib/mock/generators/stacks';
import { loadDemoSettings } from '@/lib/mock/generators/settings';
import { settingsUpdates, stackStatusUpdates } from '@/lib/mock/live-updates';
import { DOCKER_ENTITIES } from '@/lib/mock/entities';

const LOG_INTERVAL_MS = 3000;

interface MuxCommand {
  type?: unknown;
  ref?: unknown;
  topics?: unknown;
}

function eventFrame(topic: string, kind: string, payload: unknown): string {
  return JSON.stringify({ type: 'event', topic, kind, payload });
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
