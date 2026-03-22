import Dockerode from 'dockerode';
import { authenticateRequest } from './middleware';
import { handleHealth } from './routes/health';
import { handleStatsStream } from './routes/stats';
import { handleLogStream } from './routes/logs';
import { handleStackDeploy, handleStackTeardown, handleStackRestart, handleStackStatus } from './routes/stacks';
import { handleStackEvents } from './routes/stack-events';
import { handleZfsStatsStream, handleZfsPools } from './routes/zfs';
import { detectZfsCapabilities } from './lib/zfs-capabilities';

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
const AGENT_TOKEN_FILE = process.env.AGENT_TOKEN_FILE;
const AGENT_TOKEN_ENV = process.env.AGENT_TOKEN;
const DOCKER_HOST = process.env.DOCKER_HOST;

let AGENT_TOKEN: string;
if (AGENT_TOKEN_FILE) {
  const file = Bun.file(AGENT_TOKEN_FILE);
  if (!(await file.exists())) {
    console.error(`AGENT_TOKEN_FILE not found: ${AGENT_TOKEN_FILE}`);
    process.exit(1);
  }
  AGENT_TOKEN = (await file.text()).trim();
} else if (AGENT_TOKEN_ENV) {
  AGENT_TOKEN = AGENT_TOKEN_ENV;
} else {
  console.error('AGENT_TOKEN or AGENT_TOKEN_FILE environment variable is required');
  process.exit(1);
}

const TLS_CERT_PATH = process.env.TLS_CERT_PATH;
const TLS_KEY_PATH = process.env.TLS_KEY_PATH;

const tlsConfig = TLS_CERT_PATH && TLS_KEY_PATH
  ? { cert: Bun.file(TLS_CERT_PATH), key: Bun.file(TLS_KEY_PATH) }
  : undefined;

let docker: Dockerode | null = null;
if (DOCKER_HOST) {
  let dockerUrl: URL;
  try {
    dockerUrl = new URL(DOCKER_HOST.replace('tcp://', 'http://'));
  } catch {
    console.error(`Invalid DOCKER_HOST URL: '${DOCKER_HOST}'. Expected format: tcp://host:port`);
    process.exit(1);
  }
  const isHttps = dockerUrl.protocol === 'https:';
  const dockerPort = Number(dockerUrl.port) || (isHttps ? 2376 : 2375);
  docker = new Dockerode({
    host: dockerUrl.hostname,
    port: dockerPort,
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

  if (docker) {
    if (url.pathname === '/stats/stream' && request.method === 'GET') return handleStatsStream(docker, request);

    const logsMatch = /^\/logs\/([a-zA-Z0-9][a-zA-Z0-9_.-]*)$/.exec(url.pathname);
    if (logsMatch && request.method === 'GET') return handleLogStream(docker, logsMatch[1], request);

    if (url.pathname === '/stacks/events' && request.method === 'GET') return handleStackEvents(docker, request);
    if (url.pathname === '/stacks/deploy' && request.method === 'POST') return handleStackDeploy(request, STACKS_DIR);
    if (url.pathname === '/stacks/teardown' && request.method === 'POST') return handleStackTeardown(request, STACKS_DIR);
    if (url.pathname === '/stacks/restart' && request.method === 'POST') return handleStackRestart(request, STACKS_DIR);
    if (url.pathname === '/stacks/status' && request.method === 'GET') return handleStackStatus(STACKS_DIR);
  }

  if (url.pathname === '/zfs/stats/stream' && request.method === 'GET') return handleZfsStatsStream(request, zfsCapabilities);
  if (url.pathname === '/zfs/pools' && request.method === 'GET') return handleZfsPools(zfsCapabilities);

  return null;
}

Bun.serve({
  port: PORT,
  tls: tlsConfig,
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);

      const authError = authenticateRequest(request.headers, AGENT_TOKEN, url.pathname);
      if (authError) return authError;

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
