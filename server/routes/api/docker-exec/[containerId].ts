import { defineWebSocketHandler } from 'h3';
import type { Peer, WSError } from 'crossws';

// Maps peer.id to the upstream agent WebSocket so message/close can reach it.
// Keyed by peer.id (string) because Nitro's crossws Peer has no typed connection object.
const agentConnections = new Map<string, WebSocket>();

// xterm default geometry; used as fallback when the client supplies missing/invalid cols/rows.
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
// Matches the agent's clamp at agent/src/routes/exec.ts so the proxy can never
// forward a value the agent would reject.
const MIN_DIM = 1;
const MAX_DIM = 500;

function clampDim(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < MIN_DIM) return MIN_DIM;
  if (i > MAX_DIM) return MAX_DIM;
  return i;
}

export default defineWebSocketHandler({
  upgrade(request) {
    const url = new URL(request.url);
    if (!url.searchParams.get('host')) {
      throw Response.json({ error: 'Missing host parameter' }, { status: 400 });
    }
  },

  async open(peer: Peer) {
    // Messages arriving before agentConnections.set() completes are dropped by the
    // message handler's readyState check. The async window here is the DB lookup +
    // JWT sign + agent WS handshake; client input before that is discarded.
    const url = new URL(peer.request.url);
    const pathParts = url.pathname.split('/').filter(Boolean);
    const containerId = pathParts.at(-1)!;
    const host = url.searchParams.get('host')!;
    const shell = url.searchParams.get('shell') ?? 'auto';
    // Defense-in-depth: clamp to integers in [1, 500] before interpolating into the
    // agent URL. Without this, a client could inject extra query params via
    // ?cols=80%26evil=x even though the agent regex-validates containerId and
    // ignores unknown params today.
    const cols = clampDim(url.searchParams.get('cols'), DEFAULT_COLS);
    const rows = clampDim(url.searchParams.get('rows'), DEFAULT_ROWS);

    try {
      // Dynamic imports required: static imports break the client bundle with node:async_hooks errors.
      const { databaseConnectionManager } = await import('../../../../src/lib/clients/database-client');
      const { loadDatabaseConfig } = await import('../../../../src/lib/config/database-config');
      const { HostRepository } = await import('../../../../src/lib/database/repositories/host-repository');
      const dbClient = await databaseConnectionManager.getClient(loadDatabaseConfig());
      const hostRepo = new HostRepository(dbClient.getPool());
      const managedHost = await hostRepo.findByName(host);

      if (!managedHost) {
        peer.close(1011, 'Unknown host');
        return;
      }

      const { AgentKeypairsRepository } = await import('../../../../src/lib/database/repositories/agent-keypairs-repository');
      const { loadMasterKeyring } = await import('../../../../src/lib/crypto/master-key');
      const { signAgentJwt } = await import('../../../../src/lib/crypto/agent-jwt');
      const keyring = await loadMasterKeyring();
      const keypairs = new AgentKeypairsRepository(dbClient.getPool(), keyring);
      const privateKey = await keypairs.getPrivateKeyForHost(host);

      if (!privateKey) {
        peer.close(1011, 'No agent keypair for host');
        return;
      }

      const jwt = await signAgentJwt(privateKey, host);

      // Convert http/https to ws/wss for the agent WebSocket URL.
      const agentBase = managedHost.agentUrl.replace(/^https?/, (m) => m === 'https' ? 'wss' : 'ws');
      const agentUrl = `${agentBase}/exec/${encodeURIComponent(containerId)}?shell=${encodeURIComponent(shell)}&cols=${cols}&rows=${rows}`;

      // The second argument to WebSocket is a Bun-specific extension for custom headers.
      // Standard WebSocket only accepts a protocols string array, so we cast to satisfy TS.
      const agentWs = new WebSocket(agentUrl, {
        headers: { Authorization: `Bearer ${jwt}` },
      } as unknown as string[]);

      agentConnections.set(peer.id, agentWs);
      agentWs.binaryType = 'arraybuffer';

      agentWs.onmessage = (event) => {
        try {
          // crossws peer.send expects BufferSource for binary; Uint8Array is more
          // portable than Buffer across adapters (some stringify Buffer via .toString()).
          peer.send(event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data);
        } catch (err) {
          // Peer is gone but the agent stream is still running with nowhere to
          // deliver to. Close it (1001 going-away) so the upstream exec session
          // stops producing output and the agent can free resources.
          console.error('[docker-exec-ws] peer.send failed, closing agent ws:', err instanceof Error ? err.message : String(err), { host, containerId });
          try { agentWs.close(1001); } catch { /* already closed */ }
        }
      };

      agentWs.onclose = (event) => {
        agentConnections.delete(peer.id);
        try { peer.close(event.code || 1000, event.reason || ''); } catch { /* already closed */ }
      };

      agentWs.onerror = (ev: Event) => {
        // Without this log the operator sees nothing for upstream failures
        // (DNS, connection refused, expired JWT, TLS handshake, agent crash);
        // the browser only sees a generic 1011 close.
        const detail = (ev as ErrorEvent).error;
        console.error('[docker-exec-ws] agent ws error:', {
          host,
          containerId,
          error: detail instanceof Error ? detail.message : String(detail ?? 'unknown'),
        });
        agentConnections.delete(peer.id);
        try { peer.close(1011, 'Agent connection error'); } catch { /* already closed */ }
      };
    } catch (err) {
      // If open() threw between agentConnections.set() and a later teardown,
      // the map entry would leak. Delete here so retries on the same peer.id
      // don't hit a stale WebSocket reference.
      agentConnections.delete(peer.id);
      console.error('[docker-exec-ws] open error:', err instanceof Error ? err.message : String(err));
      try { peer.close(1011, 'Internal error'); } catch { /* already closed */ }
    }
  },

  message(peer: Peer, message) {
    const agentWs = agentConnections.get(peer.id);
    if (!agentWs || agentWs.readyState !== WebSocket.OPEN) return;
    // rawData may be ArrayBuffer, Buffer, or null depending on binaryType and crossws adapter.
    const raw = (message as { rawData?: ArrayBuffer | Buffer | null }).rawData ?? message.text();
    if (raw instanceof ArrayBuffer) {
      agentWs.send(raw);
    } else if (Buffer.isBuffer(raw)) {
      // WebSocket.send() expects BufferSource; convert Buffer (which has ArrayBufferLike) to Uint8Array.
      agentWs.send(new Uint8Array(raw));
    } else {
      agentWs.send(raw);
    }
  },

  close(peer: Peer) {
    const agentWs = agentConnections.get(peer.id);
    if (agentWs) {
      agentConnections.delete(peer.id);
      try { agentWs.close(1000); } catch { /* already closed */ }
    }
  },

  error(peer: Peer, err?: WSError) {
    console.error('[docker-exec-ws] peer error:', { peerId: peer.id, error: err?.message ?? '(no error)' });
    const agentWs = agentConnections.get(peer.id);
    if (agentWs) {
      agentConnections.delete(peer.id);
      try { agentWs.close(1011); } catch { /* already closed */ }
    }
  },
});
