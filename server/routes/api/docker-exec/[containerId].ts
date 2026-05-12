import { defineWebSocketHandler } from 'h3';
import type { Peer } from 'crossws';

// Maps peer.id to the upstream agent WebSocket so message/close can reach it.
// Keyed by peer.id (string) because Nitro's crossws Peer has no typed connection object.
const agentConnections = new Map<string, WebSocket>();

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
    const cols = url.searchParams.get('cols') ?? '80';
    const rows = url.searchParams.get('rows') ?? '24';

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
          peer.send(event.data instanceof ArrayBuffer ? Buffer.from(event.data) : event.data);
        } catch {
          // peer already closed
        }
      };

      agentWs.onclose = (event) => {
        agentConnections.delete(peer.id);
        try { peer.close(event.code || 1000, event.reason || ''); } catch { /* already closed */ }
      };

      agentWs.onerror = () => {
        agentConnections.delete(peer.id);
        try { peer.close(1011, 'Agent connection error'); } catch { /* already closed */ }
      };
    } catch (err) {
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

  error(peer: Peer) {
    const agentWs = agentConnections.get(peer.id);
    if (agentWs) {
      agentConnections.delete(peer.id);
      try { agentWs.close(1011); } catch { /* already closed */ }
    }
  },
});
