import Dockerode from 'dockerode';
import { authenticateRequest } from './middleware';
import { handleHealth, handleInfo } from './routes/health';
import { handleStatsStream } from './routes/stats';
import { handleLogStream } from './routes/logs';
import { handleStackDeploy, handleStackTeardown, handleStackRestart, handleStackStart, handleStackStop, handleStackStatus } from './routes/stacks';
import { handleContainerEvents } from './routes/containers-events';
import { handleContainerStart, handleContainerStop, handleContainerRestart } from './routes/containers';
import { handleZfsStatsStream, handleZfsPools } from './routes/zfs';
import { detectZfsCapabilities } from './lib/zfs-capabilities';
import { handleAgentUpdate } from './routes/agent-update';
import { handleExecSocket, handleExecMessage } from './routes/exec';

const portEnv = process.env.AGENT_PORT;
let PORT = 9090;
if (portEnv !== undefined && portEnv !== '') {
  PORT = Number(portEnv);
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    console.error(`Invalid AGENT_PORT: '${portEnv}'. Must be an integer between 1 and 65535.`);
    process.exit(1);
  }
}
const STACKS_DIR = process.env.STACKS_DIR || '/opt/homelab-manager/stacks';
const AGENT_CONTAINER_NAME = process.env.AGENT_CONTAINER_NAME ?? 'hlm-agent';
const AGENT_TRUSTED_PUBKEY_FILE = process.env.AGENT_TRUSTED_PUBKEY_FILE;
const AGENT_TRUSTED_PUBKEY_ENV = process.env.AGENT_TRUSTED_PUBKEY;
// Managed host name; manager JWTs carry it as aud, so a token minted for
// another host is rejected even if the keypair was reused.
const AGENT_HOST_NAME = process.env.AGENT_HOST_NAME?.trim();
if (!AGENT_HOST_NAME) {
  console.error('AGENT_HOST_NAME environment variable is required');
  process.exit(1);
}
const DOCKER_HOST = process.env.DOCKER_HOST;

let trustedPubkeyJson: string;
if (AGENT_TRUSTED_PUBKEY_FILE) {
  const file = Bun.file(AGENT_TRUSTED_PUBKEY_FILE);
  const POLL_INTERVAL_MS = 1000;
  const POLL_TIMEOUT_MS = 60_000;
  let waited = 0;
  while (!(await file.exists())) {
    if (waited === 0) console.info(`Waiting for AGENT_TRUSTED_PUBKEY_FILE: ${AGENT_TRUSTED_PUBKEY_FILE}`);
    if (waited >= POLL_TIMEOUT_MS) {
      console.error(`AGENT_TRUSTED_PUBKEY_FILE not found after ${POLL_TIMEOUT_MS / 1000}s: ${AGENT_TRUSTED_PUBKEY_FILE}`);
      process.exit(1);
    }
    if (waited > 0 && waited % 10_000 === 0) {
      console.info(`Still waiting for AGENT_TRUSTED_PUBKEY_FILE (${waited / 1000}s elapsed)...`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    waited += POLL_INTERVAL_MS;
  }
  try {
    trustedPubkeyJson = (await file.text()).trim();
  } catch (err) {
    console.error(`Failed to read AGENT_TRUSTED_PUBKEY_FILE '${AGENT_TRUSTED_PUBKEY_FILE}': ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
} else if (AGENT_TRUSTED_PUBKEY_ENV) {
  trustedPubkeyJson = AGENT_TRUSTED_PUBKEY_ENV.trim();
} else {
  console.error('AGENT_TRUSTED_PUBKEY or AGENT_TRUSTED_PUBKEY_FILE environment variable is required');
  process.exit(1);
}

if (trustedPubkeyJson === '') {
  console.error('AGENT_TRUSTED_PUBKEY is empty after trimming');
  process.exit(1);
}

const { loadTrustedPublicKey } = await import('./lib/jwt-auth');
let TRUSTED_PUBKEY: CryptoKey;
try {
  TRUSTED_PUBKEY = await loadTrustedPublicKey(trustedPubkeyJson);
} catch (err) {
  console.error(`Failed to parse AGENT_TRUSTED_PUBKEY: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const TLS_CERT_PATH = process.env.TLS_CERT_PATH;
const TLS_KEY_PATH = process.env.TLS_KEY_PATH;

if ((TLS_CERT_PATH && !TLS_KEY_PATH) || (!TLS_CERT_PATH && TLS_KEY_PATH)) {
  console.error('Both TLS_CERT_PATH and TLS_KEY_PATH must be set together. Only one was provided.');
  process.exit(1);
}

const tlsConfig = TLS_CERT_PATH && TLS_KEY_PATH
  ? { cert: Bun.file(TLS_CERT_PATH), key: Bun.file(TLS_KEY_PATH) }
  : undefined;

let docker: Dockerode | null = null;
let dockerHostname = '';
let dockerPortNum = 0;
if (DOCKER_HOST) {
  let dockerUrl: URL;
  try {
    dockerUrl = new URL(DOCKER_HOST.replace('tcp://', 'http://'));
  } catch {
    console.error(`Invalid DOCKER_HOST URL: '${DOCKER_HOST}'. Expected format: tcp://host:port`);
    process.exit(1);
  }
  const isHttps = dockerUrl.protocol === 'https:';
  dockerPortNum = Number(dockerUrl.port) || (isHttps ? 2376 : 2375);
  dockerHostname = dockerUrl.hostname;
  docker = new Dockerode({
    host: dockerHostname,
    port: dockerPortNum,
    protocol: isHttps ? 'https' : 'http',
  });
}

const zfsCapabilities = await detectZfsCapabilities();

if (!docker && !zfsCapabilities.available) {
  console.error('No capabilities available. Set DOCKER_HOST for Docker support, or ensure zpool is installed for ZFS support.');
  process.exit(1);
}

/**
 * Match a request to its route handler. Returns a Response if matched, or null for 404.
 */
function matchRoute(request: Request, url: URL): Promise<Response> | Response | null {
  if (url.pathname === '/health' && request.method === 'GET') return handleHealth(docker, zfsCapabilities);
  if (url.pathname === '/info' && request.method === 'GET') return handleInfo(docker, zfsCapabilities);
  if (url.pathname === '/auth/verify' && request.method === 'GET') return Response.json({ status: 'ok' });

  if (docker) {
    if (url.pathname === '/stats/stream' && request.method === 'GET') return handleStatsStream(docker, request);

    const logsMatch = /^\/logs\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)$/.exec(url.pathname);
    if (logsMatch && request.method === 'GET') return handleLogStream(docker, logsMatch[1], request);

    if (url.pathname === '/containers/events' && request.method === 'GET') return handleContainerEvents(docker, request);

    const containerControlMatch = /^\/containers\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)\/([a-z]+)$/.exec(url.pathname);
    if (containerControlMatch && request.method === 'POST') {
      const [, containerId, action] = containerControlMatch;
      if (action === 'start') return handleContainerStart(docker, containerId, request);
      if (action === 'stop') return handleContainerStop(docker, containerId, request);
      if (action === 'restart') return handleContainerRestart(docker, containerId, request);
    }
    if (url.pathname === '/stacks/deploy' && request.method === 'POST') return handleStackDeploy(request, STACKS_DIR);
    if (url.pathname === '/stacks/teardown' && request.method === 'POST') return handleStackTeardown(request, STACKS_DIR);
    if (url.pathname === '/stacks/restart' && request.method === 'POST') return handleStackRestart(request, STACKS_DIR);
    if (url.pathname === '/stacks/start' && request.method === 'POST') return handleStackStart(request, STACKS_DIR);
    if (url.pathname === '/stacks/stop' && request.method === 'POST') return handleStackStop(request, STACKS_DIR);
    if (url.pathname === '/stacks/status' && request.method === 'GET') return handleStackStatus(STACKS_DIR);
  }

  if (url.pathname === '/zfs/stats/stream' && request.method === 'GET') return handleZfsStatsStream(request, zfsCapabilities);
  if (url.pathname === '/zfs/pools' && request.method === 'GET') return handleZfsPools(zfsCapabilities);
  if (url.pathname === '/agent/update' && request.method === 'POST') return handleAgentUpdate(docker, AGENT_CONTAINER_NAME);

  return null;
}

interface ExecWebSocketData {
  containerId: string;
  shell: string;
  cols: number;
  rows: number;
  execStream?: import('node:stream').Duplex;
  execInstance?: { resize(opts: { h: number; w: number }): Promise<void> };
}

Bun.serve<ExecWebSocketData>({
  port: PORT,
  tls: tlsConfig,
  websocket: {
    // An interactive TTY exec session must not time out on idle: the user can
    // sit at a prompt for many minutes without typing. Bun's default 120s
    // would close the socket from under them. 0 disables the timeout.
    idleTimeout: 0,
    async open(ws) {
      if (!docker) { ws.close(1011, 'Docker not available'); return; }
      await handleExecSocket(docker, dockerHostname, dockerPortNum, ws.data.containerId, ws as Parameters<typeof handleExecSocket>[4]);
    },
    async message(ws, message) {
      if (!ws.data.execStream || !ws.data.execInstance) return;
      await handleExecMessage(
        message as string | Buffer,
        ws.data.execStream,
        ws.data.execInstance,
      );
    },
    close(ws) {
      ws.data.execStream?.destroy();
    },
  },
  async fetch(request: Request, server): Promise<Response> {
    try {
      const url = new URL(request.url);

      const authError = await authenticateRequest(request.headers, TRUSTED_PUBKEY, url.pathname, AGENT_HOST_NAME);
      if (authError) return authError;

      // WebSocket upgrade for exec sessions: must happen before matchRoute since server.upgrade() is Bun-specific
      if (docker && request.headers.get('upgrade') === 'websocket') {
        const execMatch = /^\/exec\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)$/.exec(url.pathname);
        if (execMatch) {
          const containerId = execMatch[1];
          const shell = url.searchParams.get('shell') ?? 'auto';
          const cols = Number(url.searchParams.get('cols') ?? 80);
          const rows = Number(url.searchParams.get('rows') ?? 24);
          const upgraded = server.upgrade(request, { data: { containerId, shell, cols, rows } });
          if (upgraded) return undefined as unknown as Response;
          return new Response('WebSocket upgrade failed', { status: 426 });
        }
      }

      return (await matchRoute(request, url)) ?? new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('Unhandled error in request handler:', error);
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }
  },
});

if (docker) console.info(`Docker capability: enabled (${DOCKER_HOST})`);
else console.info('Docker capability: disabled (DOCKER_HOST not set)');
if (zfsCapabilities.available) console.info(`ZFS capability: tier ${zfsCapabilities.tier} (v${zfsCapabilities.version ?? 'unknown'})`);
else console.info('ZFS capability: disabled (zpool not found)');
console.info(`Using stacks directory: ${STACKS_DIR}`);
console.info(`Agent listening on port ${PORT} (${tlsConfig ? 'HTTPS' : 'HTTP'})`);
