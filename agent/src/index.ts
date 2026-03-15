import Dockerode from 'dockerode';
import { authenticateRequest } from './middleware';
import { handleHealth } from './routes/health';
import { handleStatsStream } from './routes/stats';
import { handleLogStream } from './routes/logs';
import { handleStackDeploy, handleStackTeardown, handleStackRestart, handleStackStatus } from './routes/stacks';

const PORT = Number(process.env.AGENT_PORT) || 9090;
const STACKS_DIR = process.env.STACKS_DIR || '/opt/homelab-manager/stacks';
const AGENT_TOKEN = process.env.AGENT_TOKEN;
const DOCKER_HOST = process.env.DOCKER_HOST;

if (!AGENT_TOKEN) {
  console.error('AGENT_TOKEN environment variable is required');
  process.exit(1);
}

if (!DOCKER_HOST) {
  console.error('DOCKER_HOST environment variable is required');
  process.exit(1);
}

let dockerUrl: URL;
try {
  dockerUrl = new URL(DOCKER_HOST.replace('tcp://', 'http://'));
} catch {
  console.error(`Invalid DOCKER_HOST URL: '${DOCKER_HOST}'. Expected format: tcp://host:port`);
  process.exit(1);
}
const docker = new Dockerode({
  host: dockerUrl.hostname,
  port: Number(dockerUrl.port),
  protocol: dockerUrl.protocol === 'https:' ? 'https' : 'http',
});

Bun.serve({
  port: PORT,
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);

      const authError = authenticateRequest(
        request.headers,
        AGENT_TOKEN,
        url.pathname
      );
      if (authError) return authError;

      if (url.pathname === '/health' && request.method === 'GET') {
        return handleHealth(docker);
      }

      if (url.pathname === '/stats/stream' && request.method === 'GET') {
        return handleStatsStream(docker, request);
      }

      const logsMatch = url.pathname.match(/^\/logs\/([a-zA-Z0-9_.-]+)$/);
      if (logsMatch && request.method === 'GET') {
        return handleLogStream(docker, logsMatch[1], request);
      }

      if (url.pathname === '/stacks/deploy' && request.method === 'POST') return handleStackDeploy(request, STACKS_DIR);
      if (url.pathname === '/stacks/teardown' && request.method === 'POST') return handleStackTeardown(request, STACKS_DIR);
      if (url.pathname === '/stacks/restart' && request.method === 'POST') return handleStackRestart(request, STACKS_DIR);
      if (url.pathname === '/stacks/status' && request.method === 'GET') return handleStackStatus(STACKS_DIR);

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('Unhandled error in request handler:', error);
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }
  },
});

console.error(`Agent listening on port ${PORT}`);
