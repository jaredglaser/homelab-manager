import { ws } from 'msw';

import {
  generateDockerInventorySnapshot,
  generateContainerLogBatch,
  generateContainerLogHistory,
} from '@/lib/mock/generators/docker';
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

function onConnection({ client }: Parameters<Parameters<typeof mux.addEventListener<'connection'>>[1]>[0]): void {
  const feedTimers = new Map<string, ReturnType<typeof setInterval>>();

  const stopTopic = (topic: string) => {
    const timer = feedTimers.get(topic);
    if (timer !== undefined) {
      clearInterval(timer);
      feedTimers.delete(topic);
    }
  };

  const startTopic = (topic: string) => {
    stopTopic(topic);
    if (topic === 'inventory') {
      client.send(eventFrame(topic, 'data', { type: 'init', containers: generateDockerInventorySnapshot(new Date()) }));
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
    feedTimers.set(topic, setInterval(() => {
      client.send(eventFrame(topic, 'data', generateContainerLogBatch(containerName, new Date())));
    }, LOG_INTERVAL_MS));
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
    for (const timer of feedTimers.values()) clearInterval(timer);
    feedTimers.clear();
  });
}

export const wsHandlers = [mux.addEventListener('connection', onConnection)];
