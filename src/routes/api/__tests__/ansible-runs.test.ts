import { describe, it, expect, mock } from 'bun:test';

mock.module('@/lib/auth/sse-auth', () => ({
  authenticateSSE: mock(async () => ({ id: 1, role: 'admin' })),
}));

const isAnsibleEnabled = mock(() => true);
mock.module('@/lib/config/ansible-config', () => ({
  isAnsibleEnabled,
  loadAnsibleConfig: mock(() => {
    throw new Error('not used by this route');
  }),
}));

mock.module('@/lib/server-init', () => ({ initServer: mock(() => {}) }));

const { ansibleRunBroadcastService } = await import('@/lib/ansible/run-broadcast-service');
const { Route } = await import('@/routes/api/ansible-runs');

type RouteHandler = (args: { request: Request }) => Promise<Response>;

function handler(): RouteHandler {
  const options = Route.options as { server?: { handlers?: { GET?: RouteHandler } } };
  const get = options.server?.handlers?.GET;
  if (!get) throw new Error('GET handler not registered');
  return get;
}

/** Resolves once the stream's onStart has registered its subscriber, so the publish below cannot race it. */
function whenSubscribed(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (ansibleRunBroadcastService.subscriberCount > 0) resolve();
      else queueMicrotask(check);
    };
    check();
  });
}

async function readUntilData(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('data:')) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return text;
}

describe('/api/ansible-runs', () => {
  it('streams broadcast events to an authenticated subscriber', async () => {
    const controller = new AbortController();
    const response = await handler()({
      request: new Request('http://app/api/ansible-runs', { signal: controller.signal }),
    });

    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const textPromise = readUntilData(response);
    await whenSubscribed();
    ansibleRunBroadcastService.publish({ type: 'run_finished', runId: 'run-1', status: 'succeeded' });

    expect(await textPromise).toContain('"runId":"run-1"');
    controller.abort();
  });

  it('emits the channel error event when the feature flag is off', async () => {
    isAnsibleEnabled.mockImplementationOnce(() => false);
    const response = await handler()({ request: new Request('http://app/api/ansible-runs') });
    const text = await new Response(response.body).text();

    expect(text).toContain('event: ansible_runs_error');
    expect(text).toContain('Ansible execution is disabled');
  });
});
