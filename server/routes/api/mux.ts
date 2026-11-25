import { defineWebSocketHandler } from 'h3';
import type { Peer, WSError } from 'crossws';
import { agentFetch, isTlsUrl, missingPinMessage } from '../../../src/lib/clients/agent-http';
import type { MuxFrameBody } from '../../../src/lib/mux/protocol';
import type { AuthUser } from '../../../src/lib/auth/types';
import type { MuxDropPolicyConfig, MuxWriteQueue } from '../../../src/lib/mux/drop-policy';
import { PING_INTERVAL_MS, RECONNECT_BASE_BACKOFF_MS, RECONNECT_MAX_BACKOFF_MS } from '../../../src/lib/mux/keepalive';

const LOGS_TOPIC_PREFIX = 'logs:';
const STATS_TOPIC_PREFIX = 'stats:';
const INVENTORY_TOPIC = 'inventory';
const SETTINGS_TOPIC = 'settings';
const USER_SETTINGS_TOPIC = 'user-settings';
const STACK_STATUS_TOPIC = 'stack-status';
const AGENT_INVENTORY_TOPIC = 'agent-inventory';
const IMAGE_UPDATES_TOPIC = 'image-updates';
const TLS_PROVISIONING_TOPIC = 'tls-provisioning';
export const MAX_PENDING_FRAMES = 64;
const LOGS_DEGRADED_MESSAGE = 'Agent unreachable, retrying in the background';

type EmitFrame = (frame: MuxFrameBody) => void;
/** `user` is the session's authenticated user, never a value the client sent. */
type TopicAdapter = (topic: string, emit: EmitFrame, signal: AbortSignal, user: AuthUser) => void | Promise<void>;

interface TopicStream {
  controller: AbortController;
}

interface MuxSession {
  user: AuthUser;
  topics: Map<string, TopicStream>;
  pingTimer: ReturnType<typeof setInterval> | null;
  outbox: MuxWriteQueue;
}

const sessions = new Map<string, MuxSession>();
// messages arriving before async open() finishes auth are buffered here and replayed only
// after auth succeeds; without this the client's first sub commands are silently dropped
const pendingMessages = new Map<string, string[]>();
const openingPeers = new Set<string>();

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
    if (controller.signal.aborted) return;
    if (session.outbox.pushFrame(frame) === 'failed') {
      controller.abort();
    }
  };
  const result = adapter(topic, emit, controller.signal, session.user);
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

interface Subscribable<Args extends unknown[]> {
  subscribe(...args: Args): () => void;
}

// An abort fired before this call never reaches a listener added after it, so subscribing then would never end.
export function subscribeUntilAborted<Args extends unknown[]>(
  signal: AbortSignal,
  service: Subscribable<Args>,
  ...args: NoInfer<Args>
): void {
  if (signal.aborted) return;
  const unsubscribe = service.subscribe(...args);
  signal.addEventListener('abort', () => unsubscribe(), { once: true });
}

async function inventoryAdapter(topic: string, emit: EmitFrame, signal: AbortSignal): Promise<void> {
  await import('../../../src/lib/server-init');
  const { dockerInventoryBroadcastService } = await import(
    '../../../src/lib/docker/docker-inventory-broadcast-service'
  );
  subscribeUntilAborted(signal, dockerInventoryBroadcastService, (event) => {
    emit({ topic, kind: 'data', payload: event });
  });
}

async function agentInventoryAdapter(topic: string, emit: EmitFrame, signal: AbortSignal): Promise<void> {
  await import('../../../src/lib/server-init');
  const { agentInventoryBroadcastService } = await import(
    '../../../src/lib/agents/agent-inventory-broadcast-service'
  );
  subscribeUntilAborted(signal, agentInventoryBroadcastService, (snapshot) => {
    emit({ topic, kind: 'data', payload: snapshot });
  });
}

async function settingsAdapter(topic: string, emit: EmitFrame, signal: AbortSignal): Promise<void> {
  await import('../../../src/lib/server-init');
  const { settingsBroadcastService } = await import(
    '../../../src/lib/settings/settings-broadcast-service'
  );
  subscribeUntilAborted(signal, settingsBroadcastService, (message) => {
    emit({ topic, kind: 'data', payload: message });
  });
}

async function userSettingsAdapter(topic: string, emit: EmitFrame, signal: AbortSignal, user: AuthUser): Promise<void> {
  await import('../../../src/lib/server-init');
  const { userSettingsBroadcastService } = await import(
    '../../../src/lib/settings/settings-broadcast-service'
  );
  subscribeUntilAborted(signal, userSettingsBroadcastService, (message) => {
    emit({ topic, kind: 'data', payload: message });
  }, user.id);
}

async function stackStatusAdapter(topic: string, emit: EmitFrame, signal: AbortSignal): Promise<void> {
  await import('../../../src/lib/server-init');
  const { stackStatusBroadcastService } = await import(
    '../../../src/lib/stacks/stack-status-broadcast-service'
  );
  const { toStackStatusWireMessage } = await import('../../../src/lib/channels/stack-status');
  subscribeUntilAborted(signal, stackStatusBroadcastService, (event) => {
    emit({ topic, kind: 'data', payload: toStackStatusWireMessage(event) });
  });
}

async function imageUpdatesAdapter(topic: string, emit: EmitFrame, signal: AbortSignal): Promise<void> {
  await import('../../../src/lib/server-init');
  const { imageUpdateBroadcastService } = await import(
    '../../../src/lib/stacks/image-update-broadcast-service'
  );
  const { toImageUpdateWireMessage } = await import('../../../src/lib/channels/image-updates');
  subscribeUntilAborted(signal, imageUpdateBroadcastService, (event) => {
    emit({ topic, kind: 'data', payload: toImageUpdateWireMessage(event) });
  });
}

async function tlsProvisioningAdapter(topic: string, emit: EmitFrame, signal: AbortSignal): Promise<void> {
  await import('../../../src/lib/server-init');
  const { tlsProvisioningJobs } = await import('../../../src/lib/hosts/tls-provisioning-jobs');
  subscribeUntilAborted(signal, tlsProvisioningJobs, (snapshot) => {
    emit({ topic, kind: 'data', payload: snapshot });
  });
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
  subscribeUntilAborted(
    signal,
    statsPollService,
    source,
    (rows) => emit({ topic, kind: 'data', payload: rows }),
    () => emit({ topic, kind: 'error', payload: { message: 'Stats polling failed, retrying', gone: false } }),
  );
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

// TypeScript keeps signal.aborted narrowed to false after a first check, though any await can flip it.
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
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
  if (isAborted(signal)) return;
  const dbClient = await databaseConnectionManager.getClient(loadDatabaseConfig());
  if (isAborted(signal)) return;
  const hostRepo = new HostRepository(dbClient.getPool());
  const managedHost = await hostRepo.findByName(host);
  if (isAborted(signal)) return;
  if (!managedHost) {
    emit({ topic, kind: 'error', payload: { message: `Unknown host: ${host}`, gone: true } });
    return;
  }

  const { AgentKeypairsRepository } = await import('../../../src/lib/database/repositories/agent-keypairs-repository');
  const { AgentTlsCertificatesRepository } = await import(
    '../../../src/lib/database/repositories/agent-tls-certificates-repository'
  );
  const { loadMasterKeyring } = await import('../../../src/lib/crypto/master-key');
  const { signAgentJwt } = await import('../../../src/lib/crypto/agent-jwt');
  if (isAborted(signal)) return;
  const keyring = await loadMasterKeyring();
  if (isAborted(signal)) return;
  const keypairs = new AgentKeypairsRepository(dbClient.getPool(), keyring);
  const privateKey = await keypairs.getPrivateKeyForHost(host);
  if (isAborted(signal)) return;
  if (!privateKey) {
    emit({ topic, kind: 'error', payload: { message: `No agent keypair for host: ${host}`, gone: true } });
    return;
  }

  // A missing pin is permanent, so fail as gone instead of looping as a fake agent outage.
  const tlsCerts = new AgentTlsCertificatesRepository(dbClient.getPool());
  const caCertPem = (await tlsCerts.getCertForHost(host))?.trim() || null;
  if (isAborted(signal)) return;
  if (isTlsUrl(managedHost.agentUrl) && !caCertPem) {
    emit({
      topic,
      kind: 'error',
      payload: {
        message: missingPinMessage(host),
        gone: true,
      },
    });
    return;
  }

  const jwt = await signAgentJwt(privateKey, host);
  const agentUrl = `${managedHost.agentUrl}/logs/${encodeURIComponent(containerId)}`;

  let attempt = 0;
  let degraded = false;
  for (;;) {
    if (isAborted(signal)) return;
    attempt++;
    try {
      const agentResponse = await agentFetch(agentUrl, {
        headers: { Authorization: 'Bearer ' + jwt },
        signal,
        redirect: 'manual',
      }, { caCertPem });
      if (isAborted(signal)) return;
      if (!agentResponse.ok || !agentResponse.body) {
        throw new Error(`Agent request failed with status ${agentResponse.status}`);
      }
      degraded = false;
      emit({ topic, kind: 'backlog_start', payload: {} });
      await pipeAgentSse(agentResponse.body, topic, emit, signal);
      return;
    } catch (err) {
      if (isAborted(signal)) return;
      if (!degraded) {
        degraded = true;
        console.error('[mux-ws] log upstream degraded:', err instanceof Error ? err.message : String(err), { host, containerId });
        emit({ topic, kind: 'error', payload: { message: LOGS_DEGRADED_MESSAGE, gone: false } });
      }
      const delay = Math.min(RECONNECT_BASE_BACKOFF_MS * 2 ** (attempt - 1), RECONNECT_MAX_BACKOFF_MS);
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
  async function handleCommand(peer: Peer, session: MuxSession, text: string): Promise<void> {
    const { parseCommandFrame, MAX_SESSION_TOPICS, TOPIC_LIMIT_ERROR_CODE } = await import('../../../src/lib/mux/protocol');
    // A close during the import has already torn the session down, so a topic started now is never stopped.
    if (sessions.get(peer.id) !== session) return;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
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
        peer.send(JSON.stringify({
          type: 'ack',
          ref: command.ref,
          ok: false,
          error: `Session topic limit (${MAX_SESSION_TOPICS}) reached. Unsubscribe unused topics`,
          code: TOPIC_LIMIT_ERROR_CODE,
        }));
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
  }

  return {
    async open(peer: Peer) {
      openingPeers.add(peer.id);
      let user: AuthUser | null;
      try {
        const { authenticateWsUpgrade } = await import('../../../src/lib/auth/ws-auth');
        user = await authenticateWsUpgrade(peer.request as unknown as Request);
        if (!user) {
          pendingMessages.delete(peer.id);
          openingPeers.delete(peer.id);
          try { peer.close(1008, 'Unauthorized'); } catch { /* already closed */ }
          return;
        }
      } catch (err) {
        pendingMessages.delete(peer.id);
        openingPeers.delete(peer.id);
        console.error('[mux-ws] auth failed:', err instanceof Error ? err.message : String(err));
        try { peer.close(1011, 'Internal error'); } catch { /* already closed */ }
        return;
      }

      const { MuxWriteQueue, DEFAULT_MUX_DROP_POLICY } = await import('../../../src/lib/mux/drop-policy');
      const session: MuxSession = {
        user,
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
      // A close during auth or the imports found no session to tear down, so storing one now would leak it and its ping timer.
      if (!openingPeers.delete(peer.id)) return;
      sessions.set(peer.id, session);
      session.pingTimer = setInterval(() => {
        session.outbox.pushPing();
      }, PING_INTERVAL_MS);

      const buffered = pendingMessages.get(peer.id);
      if (!buffered) return;
      pendingMessages.delete(peer.id);
      for (const text of buffered) {
        await handleCommand(peer, session, text);
      }
    },

    async message(peer: Peer, message: { text: () => string }) {
      const session = sessions.get(peer.id);
      if (!session) {
        const buffered = pendingMessages.get(peer.id) ?? [];
        if (buffered.length < MAX_PENDING_FRAMES) {
          buffered.push(message.text());
          pendingMessages.set(peer.id, buffered);
        }
        return;
      }
      await handleCommand(peer, session, message.text());
    },

    close(peer: Peer) {
      pendingMessages.delete(peer.id);
      openingPeers.delete(peer.id);
      teardownSession(peer);
    },

    error(peer: Peer, err?: WSError) {
      console.error('[mux-ws] peer error:', { peerId: peer.id, error: err?.message ?? '(no error)' });
      pendingMessages.delete(peer.id);
      openingPeers.delete(peer.id);
      teardownSession(peer);
    },
  };
}

export const STATIC_TOPIC_ADAPTERS: Record<string, TopicAdapter> = {
  [INVENTORY_TOPIC]: inventoryAdapter,
  [SETTINGS_TOPIC]: settingsAdapter,
  [USER_SETTINGS_TOPIC]: userSettingsAdapter,
  [STACK_STATUS_TOPIC]: stackStatusAdapter,
  [AGENT_INVENTORY_TOPIC]: agentInventoryAdapter,
  [IMAGE_UPDATES_TOPIC]: imageUpdatesAdapter,
  [TLS_PROVISIONING_TOPIC]: tlsProvisioningAdapter,
};

export const PREFIX_TOPIC_ADAPTERS = [
  { prefix: LOGS_TOPIC_PREFIX, adapter: logsAdapter },
  { prefix: STATS_TOPIC_PREFIX, adapter: statsAdapter },
] as const;

export const defaultTopicAdapter: TopicAdapter = (topic, emit, signal, user) => {
  const staticAdapter = STATIC_TOPIC_ADAPTERS[topic];
  if (staticAdapter) return staticAdapter(topic, emit, signal, user);
  const prefixAdapter = PREFIX_TOPIC_ADAPTERS.find(({ prefix }) => topic.startsWith(prefix));
  if (prefixAdapter) return prefixAdapter.adapter(topic, emit, signal);
  emit({ topic, kind: 'error', payload: { message: `Unsupported topic: ${topic}`, gone: true } });
};

export default defineWebSocketHandler(createMuxWsHandlers({
  topicAdapter: defaultTopicAdapter,
}));
