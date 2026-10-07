import type { SseCleanup, SseEmitter } from '@/lib/sse/create-sse-stream';
import { consumeSseStream } from '@/lib/sse/parse-sse-stream';

/**
 * Server-side session registry for the multiplexed container-log endpoint.
 *
 * The browser holds ONE EventSource to `/api/docker-logs-mux?session=<id>` for
 * every log stream it wants; which containers are delivered is driven at
 * runtime by POSTing subscribe/unsubscribe commands to the same route. The
 * browser's HTTP/1.1 six-connections-per-origin cap makes one connection per
 * expanded row unworkable from the third expanded row on; server-to-agent
 * connections are not subject to it.
 *
 * Frame protocol (web server to browser):
 * - `event: backlog_start` `{key}` - a fresh upstream opened for this key; the
 *   agent is about to replay its backlog, so the client clears its buffer.
 * - `data: {key, line}` - one log line (backlog or live).
 * - `event: backlog_done` `{key}` - agent finished replaying.
 * - `event: stream_end` `{key}` - container stopped cleanly, upstream closed.
 * - `event: error` `{key, message, gone}` - per-key failure; other keys and
 *   the mux connection keep running.
 */

export interface MuxKey {
  host: string;
  containerId: string;
}

/** Bounds server-to-agent fan-out per browser session. */
export const MAX_MUX_STREAMS = 20;

const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export function parseMuxKey(raw: string): MuxKey | null {
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) return null;
  const host = raw.slice(0, slash);
  const containerId = raw.slice(slash + 1);
  if (!KEY_PATTERN.test(host) || !KEY_PATTERN.test(containerId)) return null;
  return { host, containerId };
}

export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID_PATTERN.test(id);
}

interface KeyStream {
  controller: AbortController;
}

interface MuxSession {
  keys: Map<string, KeyStream>;
  /** Null while the session has no attached SSE response; frames are dropped. */
  emit: SseEmitter | null;
}

const sessions = new Map<string, MuxSession>();
const activePipes = new Set<Promise<void>>();

function teardownSession(session: MuxSession): void {
  for (const keyStream of session.keys.values()) keyStream.controller.abort();
  session.keys.clear();
  session.emit = null;
}

/** Test-only: dispose every session and reset module state between tests. */
export function _resetLogMuxSessions(): void {
  for (const session of sessions.values()) teardownSession(session);
  sessions.clear();
  activePipes.clear();
}

/** Test-only: resolves once every in-flight upstream pipe has settled. */
export function _flushLogMuxPipes(): Promise<void> {
  return Promise.all([...activePipes]).then(() => {});
}

/**
 * Attaches an SSE response to a session id. A reconnecting client reuses the
 * same session id, so an existing session is torn down and rebuilt fresh; the
 * client re-POSTs its full key set on open, which repopulates it.
 */
export function attachSession(sessionId: string, emit: SseEmitter): SseCleanup {
  const existing = sessions.get(sessionId);
  if (existing) teardownSession(existing);

  const session: MuxSession = { keys: new Map(), emit };
  sessions.set(sessionId, session);

  return () => {
    const current = sessions.get(sessionId);
    if (current === session) {
      teardownSession(session);
      sessions.delete(sessionId);
    }
  };
}

export interface MuxMutationResult {
  ok: boolean;
  reason?: 'unknown-session' | 'too-many-streams' | 'invalid-key';
}

/**
 * Applies a subscribe/unsubscribe command to a live session. Subscribing an
 * already-active key resyncs it: the upstream is reopened so the agent
 * replays the backlog. Per-key upstream failures surface as an `error` event
 * for that key only.
 */
export async function mutateSession(
  sessionId: string,
  subscribe: string[],
  unsubscribe: string[],
): Promise<MuxMutationResult> {
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, reason: 'unknown-session' };
  if (session.keys.size + subscribe.length > MAX_MUX_STREAMS) {
    return { ok: false, reason: 'too-many-streams' };
  }
  const parsed = new Map<string, MuxKey>();
  for (const key of subscribe) {
    const value = parseMuxKey(key);
    if (!value) return { ok: false, reason: 'invalid-key' };
    parsed.set(key, value);
  }

  for (const key of unsubscribe) {
    const keyStream = session.keys.get(key);
    if (keyStream) {
      keyStream.controller.abort();
      session.keys.delete(key);
    }
  }

  for (const [key, value] of parsed) {
    const existing = session.keys.get(key);
    if (existing) existing.controller.abort();
    const controller = new AbortController();
    session.keys.set(key, { controller });
    const pipe = pipeKey(session, key, value, controller);
    activePipes.add(pipe);
    void pipe.then(
      () => activePipes.delete(pipe),
      () => activePipes.delete(pipe),
    );
  }

  return { ok: true };
}

function emitKeyError(session: MuxSession, key: string, message: string): void {
  session.emit?.event('error', { key, message, gone: false });
}

async function resolveAgent(hostName: string): Promise<{ agentUrl: string; jwt: string }> {
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { HostRepository } = await import('@/lib/database/repositories/host-repository');
  const dbClient = await databaseConnectionManager.getClient(loadDatabaseConfig());
  const hostRepo = new HostRepository(dbClient.getPool());
  const managedHost = await hostRepo.findByName(hostName);
  if (!managedHost) {
    throw new Error(`Unknown host: ${hostName}`);
  }

  const { AgentKeypairsRepository } = await import('@/lib/database/repositories/agent-keypairs-repository');
  const { loadMasterKeyring } = await import('@/lib/crypto/master-key');
  const { signAgentJwt } = await import('@/lib/crypto/agent-jwt');
  const keyring = await loadMasterKeyring();
  const keypairs = new AgentKeypairsRepository(dbClient.getPool(), keyring);
  const privateKey = await keypairs.getPrivateKeyForHost(hostName);
  if (!privateKey) {
    throw new Error(`No agent keypair for host: ${hostName}`);
  }

  return { agentUrl: managedHost.agentUrl, jwt: await signAgentJwt(privateKey, hostName) };
}

interface AgentErrorPayload {
  message: string;
  gone: boolean;
}

function parseAgentError(data: string): AgentErrorPayload {
  try {
    const parsed = JSON.parse(data) as { message?: string; error?: string; gone?: boolean };
    return {
      message: parsed.message ?? parsed.error ?? 'Log stream error',
      gone: parsed.gone ?? false,
    };
  } catch {
    return { message: 'Log stream error', gone: false };
  }
}

function parseAgentLine(data: string): { text: string; stream: string } | null {
  try {
    const parsed = JSON.parse(data) as { text?: unknown; stream?: unknown };
    if (typeof parsed.text !== 'string' || typeof parsed.stream !== 'string') return null;
    return { text: parsed.text, stream: parsed.stream };
  } catch {
    return null;
  }
}

/** Runs until the upstream ends (live-follow streams end only on abort). */
async function pipeKey(
  session: MuxSession,
  key: string,
  parsed: MuxKey,
  controller: AbortController,
): Promise<void> {
  try {
    const agent = await resolveAgent(parsed.host);
    const agentResponse = await fetch(`${agent.agentUrl}/logs/${encodeURIComponent(parsed.containerId)}`, {
      headers: { Authorization: `Bearer ${agent.jwt}` },
      signal: controller.signal,
      redirect: 'manual',
    });

    if (agentResponse.type === 'opaqueredirect' || (agentResponse.status >= 300 && agentResponse.status < 400)) {
      emitKeyError(session, key, 'Agent URL returned an unexpected redirect');
      return;
    }

    if (!agentResponse.ok || !agentResponse.body) {
      const msg = await agentResponse.text().catch(() => 'Agent request failed');
      emitKeyError(session, key, msg.slice(0, 200));
      return;
    }

    session.emit?.event('backlog_start', { key });
    await consumeSseStream(agentResponse.body, controller.signal, (frame) => {
      if (frame.event === 'backlog_done' || frame.event === 'stream_end') {
        session.emit?.event(frame.event, { key });
        return;
      }
      if (frame.event === 'error') {
        const payload = parseAgentError(frame.data);
        session.emit?.event('error', { key, message: payload.message, gone: payload.gone });
        return;
      }
      if (frame.event !== null) return;
      const line = parseAgentLine(frame.data);
      if (line) session.emit?.data({ key, line });
    });
  } catch (err) {
    if (!controller.signal.aborted) {
      emitKeyError(session, key, err instanceof Error ? err.message : 'Log stream failed');
    }
  } finally {
    const current = session.keys.get(key);
    if (current?.controller === controller) session.keys.delete(key);
  }
}
