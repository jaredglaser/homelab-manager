import { defineWebSocketHandler } from 'h3';
import type { Peer, WSError } from 'crossws';
import type { MuxFrameBody } from '../../../src/lib/mux/protocol';
import type { MuxDropPolicyConfig, MuxWriteQueue } from '../../../src/lib/mux/drop-policy';

const LOGS_TOPIC_PREFIX = 'logs:';
const STATS_TOPIC_PREFIX = 'stats:';
const INVENTORY_TOPIC = 'inventory';
const MAX_SESSION_TOPICS = 20;
const PING_INTERVAL_MS = 25_000;
const AGENT_BASE_BACKOFF_MS = 1_000;
const AGENT_MAX_BACKOFF_MS = 16_000;
const LOGS_DEGRADED_MESSAGE = 'Agent unreachable, retrying in the background';

type EmitFrame = (frame: MuxFrameBody) => void;
type TopicAdapter = (topic: string, emit: EmitFrame, signal: AbortSignal) => void | Promise<void>;

interface TopicStream {
  controller: AbortController;
}

interface MuxSession {
  topics: Map<string, TopicStream>;
  pingTimer: ReturnType<typeof setInterval> | null;
  outbox: MuxWriteQueue;
}

const sessions = new Map<string, MuxSession>();

function stopTopic(session: MuxSession, topic: string): void {
  const stream = session.topics.get(topic);
  if (stream) {
    session.topics.delete(topic);
    stream.controller.abort();
    session.outbox.clearTopic(topic);
  }
}

function teardownSession(peer: Peer): void {
  const session = sessions.get(peer.id);
  if (!session) return;
  sessions.delete(peer.id);
  if (session.pingTimer !== null) clearInterval(session.pingTimer);
  for (const topic of [...session.topics.keys()]) stopTopic(session, topic);
  session.outbox.dispose();
}

function startTopic(session: MuxSession, topic: string, adapter: TopicAdapter): void {
  stopTopic(session, topic);
  const controller = new AbortController();
  session.topics.set(topic, { controller });
  const emit: EmitFrame = (frame) => {
    if (session.outbox.pushFrame(frame) === 'failed') {
      controller.abort();
    }
  };
  const result = adapter(topic, emit, controller.signal);
  if (result instanceof Promise) {
    result.catch((err: unknown) => {
      console.error('[mux-ws] topic adapter failed:', err instanceof Error ? err.message : String(err), { topic });
      if (session.topics.get(topic)?.controller === controller) {
        emit({ topic, kind: 'error', payload: { message: 'Stream failed to start', gone: true } });
        stopTopic(session, topic);
      }
    });
  }
}

async function inventoryAdapter(topic: string, emit: EmitFrame, signal: AbortSignal): Promise<void> {
  await import('../../../src/lib/server-init');
  const { dockerInventoryBroadcastService } = await import(
    '../../../src/lib/docker/docker-inventory-broadcast-service'
  );
  const unsubscribe = dockerInventoryBroadcastService.subscribe((event) => {
    emit({ topic, kind: 'data', payload: event });
  });
  signal.addEventListener('abort', () => unsubscribe(), { once: true });
}

async function statsAdapter(topic: string, emit: EmitFrame, signal: AbortSignal): Promise<void> {
  const { parseStatsTopic } = await import('../../../src/lib/mux/protocol');
  const source = parseStatsTopic(topic);
  if (!source) {
    emit({ topic, kind: 'error', payload: { message: 'Invalid stats topic', gone: true } });
    return;
  }
  await import('../../../src/lib/server-init');
  const { statsPollService } = await import('../../../src/lib/database/subscription-service');
  const unsubscribe = statsPollService.subscribe(
    source,
    (rows) => emit({ topic, kind: 'data', payload: rows }),
    () => emit({ topic, kind: 'error', payload: { message: 'Stats polling failed, retrying', gone: false } }),
  );
  signal.addEventListener('abort', () => unsubscribe(), { once: true });
}

export function parseAgentSseBlock(block: string): { event: string; data: string } {
  let eventName = 'message';
  const dataParts: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':') || line === '') continue;
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataParts.push(line.slice('data:'.length).trimStart());
    }
  }
  return { event: eventName, data: dataParts.join('\n') };
}

async function logsAdapter(topic: string, emit: EmitFrame, signal: AbortSignal): Promise<void> {
  const { parseLogsTopic } = await import('../../../src/lib/mux/protocol');
  const parsed = parseLogsTopic(topic);
  if (!parsed) {
    emit({ topic, kind: 'error', payload: { message: 'Invalid logs topic', gone: true } });
    return;
  }
  const { host, containerId } = parsed;

  const { databaseConnectionManager } = await import('../../../src/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('../../../src/lib/config/database-config');
  const { HostRepository } = await import('../../../src/lib/database/repositories/host-repository');
  const dbClient = await databaseConnectionManager.getClient(loadDatabaseConfig());
  const hostRepo = new HostRepository(dbClient.getPool());
  const managedHost = await hostRepo.findByName(host);
  if (!managedHost) {
    emit({ topic, kind: 'error', payload: { message: `Unknown host: ${host}`, gone: true } });
    return;
  }

  const { AgentKeypairsRepository } = await import('../../../src/lib/database/repositories/agent-keypairs-repository');
  const { loadMasterKeyring } = await import('../../../src/lib/crypto/master-key');
  const { signAgentJwt } = await import('../../../src/lib/crypto/agent-jwt');
  const keyring = await loadMasterKeyring();
  const keypairs = new AgentKeypairsRepository(dbClient.getPool(), keyring);
  const privateKey = await keypairs.getPrivateKeyForHost(host);
  if (!privateKey) {
    emit({ topic, kind: 'error', payload: { message: `No agent keypair for host: ${host}`, gone: true } });
    return;
  }

  const jwt = await signAgentJwt(privateKey, host);
  const agentUrl = `${managedHost.agentUrl}/logs/${encodeURIComponent(containerId)}`;

  let attempt = 0;
  let degraded = false;
  for (;;) {
    if (signal.aborted) return;
    attempt++;
    try {
      const agentResponse = await fetch(agentUrl, {
        headers: { Authorization: 'Bearer ' + jwt },
        signal,
        redirect: 'manual',
      });
      if (!agentResponse.ok || !agentResponse.body) {
        throw new Error(`Agent request failed with status ${agentResponse.status}`);
      }
      degraded = false;
      emit({ topic, kind: 'backlog_start', payload: {} });
      await pipeAgentSse(agentResponse.body, topic, emit, signal);
      return;
    } catch (err) {
      if (signal.aborted) return;
      if (!degraded) {
        degraded = true;
        console.error('[mux-ws] log upstream degraded:', err instanceof Error ? err.message : String(err), { host, containerId });
        emit({ topic, kind: 'error', payload: { message: LOGS_DEGRADED_MESSAGE, gone: false } });
      }
      const delay = Math.min(AGENT_BASE_BACKOFF_MS * 2 ** (attempt - 1), AGENT_MAX_BACKOFF_MS);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
  }
}

async function pipeAgentSse(
  body: ReadableStream<Uint8Array>,
  topic: string,
  emit: EmitFrame,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || signal.aborted) return;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const { event, data } = parseAgentSseBlock(block);
        if (event === 'message') {
          let payload: unknown = null;
          try {
            payload = data ? JSON.parse(data) : null;
          } catch {
            continue;
          }
          emit({ topic, kind: 'data', payload });
        } else if (event === 'backlog_done') {
          emit({ topic, kind: 'backlog_done', payload: {} });
        } else if (event === 'stream_end') {
          emit({ topic, kind: 'stream_end', payload: {} });
          return;
        } else if (event === 'error') {
          let message = 'Log stream error';
          try {
            const parsedError = JSON.parse(data) as { message?: string; error?: string };
            message = parsedError.message ?? parsedError.error ?? message;
          } catch {
            /* keep default message */
          }
          emit({ topic, kind: 'error', payload: { message, gone: false } });
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface MuxWsDeps {
  topicAdapter: TopicAdapter;
  dropPolicy?: MuxDropPolicyConfig;
}

export function createMuxWsHandlers(deps: MuxWsDeps) {
  return {
    async open(peer: Peer) {
      try {
        const { authenticateSSE } = await import('../../../src/lib/auth/sse-auth');
        const user = await authenticateSSE(peer.request as unknown as Request);
        if (!user) {
          try { peer.close(1008, 'Unauthorized'); } catch { /* already closed */ }
          return;
        }
      } catch (err) {
        console.error('[mux-ws] auth failed:', err instanceof Error ? err.message : String(err));
        try { peer.close(1011, 'Internal error'); } catch { /* already closed */ }
        return;
      }

      const { MuxWriteQueue, DEFAULT_MUX_DROP_POLICY } = await import('../../../src/lib/mux/drop-policy');
      const session: MuxSession = {
        topics: new Map(),
        pingTimer: null,
        outbox: new MuxWriteQueue({
          send: (json) => {
            peer.send(json);
          },
          getBufferedBytes: () => peer.bufferedAmount,
          config: deps.dropPolicy ?? DEFAULT_MUX_DROP_POLICY,
          onSendError: (err, topic) => {
            console.error('[mux-ws] peer.send failed:', err instanceof Error ? err.message : String(err), { topic });
          },
        }),
      };
      sessions.set(peer.id, session);
      session.pingTimer = setInterval(() => {
        session.outbox.pushPing();
      }, PING_INTERVAL_MS);
    },

    async message(peer: Peer, message: { text: () => string }) {
      const session = sessions.get(peer.id);
      if (!session) return;

      const { parseCommandFrame } = await import('../../../src/lib/mux/protocol');
      let raw: unknown;
      try {
        raw = JSON.parse(message.text());
      } catch {
        return;
      }
      const command = parseCommandFrame(raw);
      if (!command) {
        peer.send(JSON.stringify({ type: 'ack', ref: 0, ok: false, error: 'Invalid command' }));
        return;
      }

      if (command.type === 'sub') {
        const missing = command.topics.filter((t) => !session.topics.has(t));
        if (session.topics.size + missing.length > MAX_SESSION_TOPICS) {
          peer.send(JSON.stringify({ type: 'ack', ref: command.ref, ok: false, error: 'Too many topics' }));
          return;
        }
        for (const topic of command.topics) {
          startTopic(session, topic, deps.topicAdapter);
        }
      } else {
        for (const topic of command.topics) {
          stopTopic(session, topic);
        }
      }
      peer.send(JSON.stringify({ type: 'ack', ref: command.ref, ok: true }));
    },

    close(peer: Peer) {
      teardownSession(peer);
    },

    error(peer: Peer, err?: WSError) {
      console.error('[mux-ws] peer error:', { peerId: peer.id, error: err?.message ?? '(no error)' });
      teardownSession(peer);
    },
  };
}

export const defaultTopicAdapter: TopicAdapter = (topic, emit, signal) => {
  if (topic === INVENTORY_TOPIC) {
    return inventoryAdapter(topic, emit, signal);
  }
  if (topic.startsWith(LOGS_TOPIC_PREFIX)) {
    return logsAdapter(topic, emit, signal);
  }
  if (topic.startsWith(STATS_TOPIC_PREFIX)) {
    return statsAdapter(topic, emit, signal);
  }
  emit({ topic, kind: 'error', payload: { message: `Unsupported topic: ${topic}`, gone: true } });
};

export default defineWebSocketHandler(createMuxWsHandlers({
  topicAdapter: defaultTopicAdapter,
}));
