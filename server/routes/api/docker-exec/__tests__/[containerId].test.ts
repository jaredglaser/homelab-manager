import { describe, it, expect, mock, beforeEach, beforeAll, afterAll } from 'bun:test';

// Mock all the dynamic-imported modules at module-graph boundaries.
// The route uses await import() so each mock must use the exact path the
// route imports from (relative paths in the route file, NOT @/ aliases).
const mockFindByName = mock(async (_: string) => null as null | { name: string; agentUrl: string });
const mockGetPrivateKeyForHost = mock(async (_: string) => null as null | object);
const mockSignAgentJwt = mock(async () => 'fake.jwt.token');

mock.module('../../../../../src/lib/clients/database-client', () => ({
  databaseConnectionManager: {
    getClient: async () => ({ getPool: () => ({} as object) }),
  },
}));

mock.module('../../../../../src/lib/config/database-config', () => ({
  loadDatabaseConfig: () => ({}),
}));

mock.module('../../../../../src/lib/database/repositories/host-repository', () => ({
  HostRepository: class {
    findByName = mockFindByName;
  },
}));

mock.module('../../../../../src/lib/database/repositories/agent-keypairs-repository', () => ({
  AgentKeypairsRepository: class {
    getPrivateKeyForHost = mockGetPrivateKeyForHost;
  },
}));

mock.module('../../../../../src/lib/crypto/master-key', () => ({
  loadMasterKeyring: async () => ({}),
}));

mock.module('../../../../../src/lib/crypto/agent-jwt', () => ({
  signAgentJwt: mockSignAgentJwt,
}));

// Capture every constructed mock WebSocket so tests can drive .onmessage etc.
interface ConstructedWs {
  url: string;
  init: unknown;
  binaryType: string;
  readyState: number;
  send: ReturnType<typeof mock>;
  close: ReturnType<typeof mock>;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
}
const constructedWebSockets: ConstructedWs[] = [];

const OriginalWebSocket = globalThis.WebSocket;
class MockWebSocket implements ConstructedWs {
  static OPEN = 1;
  static CLOSED = 3;
  binaryType = 'blob';
  readyState = MockWebSocket.OPEN;
  send = mock(() => {});
  close = mock(() => { this.readyState = MockWebSocket.CLOSED; });
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string, public init: unknown) {
    constructedWebSockets.push(this);
  }
}

beforeAll(() => {
  (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket;
  // Silence the route's console.error during expected error paths.
  console.error = mock(() => {});
});

afterAll(() => {
  (globalThis as unknown as { WebSocket: typeof OriginalWebSocket }).WebSocket = OriginalWebSocket;
});

const handlerModule = await import('../[containerId]');
// h3's defineWebSocketHandler wraps the hooks behind a request handler:
// when invoked it returns a 426 Response with `crossws` attached. To get the
// hook callbacks themselves, call the exported handler with any event-shaped
// argument and read `.crossws` off the resulting Response.
interface HandlerHooks {
  upgrade?: (req: { url: string }) => void;
  open: (peer: FakePeer) => Promise<void>;
  message: (peer: FakePeer, msg: FakeMessage) => void;
  close: (peer: FakePeer) => void;
  error: (peer: FakePeer) => void;
}
const exported = handlerModule.default as unknown as (event: unknown) => Response & { crossws: HandlerHooks };
const handler: HandlerHooks = exported({} as unknown).crossws;

interface FakePeer {
  id: string;
  request: { url: string };
  send: ReturnType<typeof mock>;
  close: ReturnType<typeof mock>;
}

interface FakeMessage {
  text: () => string;
  rawData?: ArrayBuffer | Buffer | null;
}

function makePeer(opts: { url: string; id?: string }): FakePeer {
  return {
    id: opts.id ?? 'peer-1',
    request: { url: opts.url },
    send: mock(() => {}),
    close: mock(() => {}),
  };
}

beforeEach(() => {
  constructedWebSockets.length = 0;
  mockFindByName.mockReset();
  mockGetPrivateKeyForHost.mockReset();
  mockSignAgentJwt.mockClear();
  mockFindByName.mockImplementation(async () => null);
  mockGetPrivateKeyForHost.mockImplementation(async () => null);
  mockSignAgentJwt.mockImplementation(async () => 'fake.jwt.token');
});

describe('docker-exec websocket route', () => {
  describe('upgrade', () => {
    it('rejects requests without host param with HTTP 400', () => {
      const req = { url: 'http://localhost:3000/api/docker-exec/abc123' };
      let thrown: unknown;
      try {
        handler.upgrade?.(req);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Response);
      expect((thrown as Response).status).toBe(400);
    });

    it('passes when host param is present', () => {
      const req = { url: 'http://localhost:3000/api/docker-exec/abc123?host=server1' };
      expect(() => handler.upgrade?.(req)).not.toThrow();
    });
  });

  describe('open', () => {
    it('closes with 1011 "Unknown host" when host is not in the registry', async () => {
      mockFindByName.mockImplementation(async () => null);
      const peer = makePeer({ url: 'http://localhost:3000/api/docker-exec/abc123?host=missing' });

      await handler.open(peer);

      expect(peer.close).toHaveBeenCalledWith(1011, 'Unknown host');
      expect(constructedWebSockets).toHaveLength(0);
    });

    it('closes with 1011 "No agent keypair for host" when no keypair exists', async () => {
      mockFindByName.mockImplementation(async () => ({ name: 'server1', agentUrl: 'http://agent.local:9000' }));
      mockGetPrivateKeyForHost.mockImplementation(async () => null);
      const peer = makePeer({ url: 'http://localhost:3000/api/docker-exec/abc123?host=server1' });

      await handler.open(peer);

      expect(peer.close).toHaveBeenCalledWith(1011, 'No agent keypair for host');
      expect(constructedWebSockets).toHaveLength(0);
    });

    it('transforms http:// agent URL to ws:// when opening the upstream WebSocket', async () => {
      mockFindByName.mockImplementation(async () => ({ name: 'server1', agentUrl: 'http://agent.local:9000' }));
      mockGetPrivateKeyForHost.mockImplementation(async () => ({}));
      const peer = makePeer({ url: 'http://localhost:3000/api/docker-exec/abc123?host=server1&shell=bash&cols=100&rows=30' });

      await handler.open(peer);

      expect(constructedWebSockets).toHaveLength(1);
      expect(constructedWebSockets[0]!.url).toBe('ws://agent.local:9000/exec/abc123?shell=bash&cols=100&rows=30');
    });

    it('transforms https:// agent URL to wss:// when opening the upstream WebSocket', async () => {
      mockFindByName.mockImplementation(async () => ({ name: 'server1', agentUrl: 'https://agent.example.com' }));
      mockGetPrivateKeyForHost.mockImplementation(async () => ({}));
      const peer = makePeer({ url: 'http://localhost:3000/api/docker-exec/abc%2Fid?host=server1' });

      await handler.open(peer);

      expect(constructedWebSockets[0]!.url.startsWith('wss://agent.example.com/exec/')).toBe(true);
    });

    it('attaches the agent JWT as a Bearer Authorization header', async () => {
      mockFindByName.mockImplementation(async () => ({ name: 'server1', agentUrl: 'http://agent.local:9000' }));
      mockGetPrivateKeyForHost.mockImplementation(async () => ({}));
      mockSignAgentJwt.mockImplementation(async () => 'jwt-xyz');
      const peer = makePeer({ url: 'http://localhost:3000/api/docker-exec/abc123?host=server1' });

      await handler.open(peer);

      const init = constructedWebSockets[0]!.init as { headers?: Record<string, string> };
      expect(init.headers?.Authorization).toBe('Bearer jwt-xyz');
    });
  });

  describe('message', () => {
    async function openSessionThenGetPeer(): Promise<FakePeer> {
      mockFindByName.mockImplementation(async () => ({ name: 'server1', agentUrl: 'http://agent.local:9000' }));
      mockGetPrivateKeyForHost.mockImplementation(async () => ({}));
      const peer = makePeer({ url: 'http://localhost:3000/api/docker-exec/abc123?host=server1' });
      await handler.open(peer);
      // Upstream is OPEN by default on the mock.
      return peer;
    }

    it('drops messages when no upstream entry exists for the peer', () => {
      const peer = makePeer({ url: 'http://localhost:3000/api/docker-exec/abc123?host=server1', id: 'no-upstream' });
      const msg: FakeMessage = { text: () => 'whatever' };
      // Should not throw and obviously cannot send anywhere.
      expect(() => handler.message(peer, msg)).not.toThrow();
    });

    it('forwards ArrayBuffer payload to the upstream WebSocket as-is', async () => {
      const peer = await openSessionThenGetPeer();
      const ab = new Uint8Array([0x68, 0x69]).buffer;
      const msg: FakeMessage = { rawData: ab, text: () => '' };
      handler.message(peer, msg);
      expect(constructedWebSockets[0]!.send).toHaveBeenCalledWith(ab);
    });

    it('forwards Buffer payload by wrapping it in a Uint8Array', async () => {
      const peer = await openSessionThenGetPeer();
      const buf = Buffer.from([1, 2, 3, 4]);
      const msg: FakeMessage = { rawData: buf, text: () => '' };
      handler.message(peer, msg);

      const sendArg = constructedWebSockets[0]!.send.mock.calls[0]?.[0];
      expect(sendArg).toBeInstanceOf(Uint8Array);
      expect(Array.from(sendArg as Uint8Array)).toEqual([1, 2, 3, 4]);
    });

    it('falls back to message.text() when rawData is absent', async () => {
      const peer = await openSessionThenGetPeer();
      const msg: FakeMessage = { rawData: null, text: () => 'ls -la' };
      handler.message(peer, msg);
      expect(constructedWebSockets[0]!.send).toHaveBeenCalledWith('ls -la');
    });
  });

  describe('close', () => {
    it('closes the upstream WebSocket and removes the connection map entry', async () => {
      mockFindByName.mockImplementation(async () => ({ name: 'server1', agentUrl: 'http://agent.local:9000' }));
      mockGetPrivateKeyForHost.mockImplementation(async () => ({}));
      const peer = makePeer({ url: 'http://localhost:3000/api/docker-exec/abc123?host=server1', id: 'peer-close' });
      await handler.open(peer);
      const upstream = constructedWebSockets[0]!;

      handler.close(peer);

      expect(upstream.close).toHaveBeenCalledWith(1000);

      // Second close: a subsequent message should be a no-op (entry deleted).
      handler.message(peer, { text: () => 'after-close' });
      // upstream.send count should not have increased from this message.
      expect(upstream.send).not.toHaveBeenCalled();
    });
  });

  describe('error', () => {
    it('closes the upstream WebSocket with 1011 and removes the connection map entry', async () => {
      mockFindByName.mockImplementation(async () => ({ name: 'server1', agentUrl: 'http://agent.local:9000' }));
      mockGetPrivateKeyForHost.mockImplementation(async () => ({}));
      const peer = makePeer({ url: 'http://localhost:3000/api/docker-exec/abc123?host=server1', id: 'peer-error' });
      await handler.open(peer);
      const upstream = constructedWebSockets[0]!;

      handler.error(peer);

      expect(upstream.close).toHaveBeenCalledWith(1011);

      handler.message(peer, { text: () => 'after-error' });
      expect(upstream.send).not.toHaveBeenCalled();
    });
  });
});
