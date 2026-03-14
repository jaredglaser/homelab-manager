import Dockerode from 'dockerode';
import { authenticateRequest } from './middleware';
import { handleHealth } from './routes/health';

const PORT = Number(process.env.AGENT_PORT) || 9090;
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

const dockerUrl = new URL(DOCKER_HOST.replace('tcp://', 'http://'));
const docker = new Dockerode({
  host: dockerUrl.hostname,
  port: Number(dockerUrl.port),
  protocol: dockerUrl.protocol === 'https:' ? 'https' : 'http',
});

Bun.serve({
  port: PORT,
  async fetch(request: Request): Promise<Response> {
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

    return new Response('Not Found', { status: 404 });
  },
});

console.error(`Agent listening on port ${PORT}`);
