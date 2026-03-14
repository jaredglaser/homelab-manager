import { authenticateRequest } from './middleware';

const PORT = Number(process.env.AGENT_PORT) || 9090;
const AGENT_TOKEN = process.env.AGENT_TOKEN;

if (!AGENT_TOKEN) {
  console.error('AGENT_TOKEN environment variable is required');
  process.exit(1);
}

Bun.serve({
  port: PORT,
  fetch(request: Request): Response {
    const url = new URL(request.url);

    const authError = authenticateRequest(
      request.headers,
      AGENT_TOKEN,
      url.pathname
    );
    if (authError) return authError;

    return new Response('Not Found', { status: 404 });
  },
});

console.error(`Agent listening on port ${PORT}`);
