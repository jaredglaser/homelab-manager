import { describe, test, expect, mock } from 'bun:test';
import { handleContainerRestart, handleContainerStart, handleContainerStop } from '../routes/containers';
import { waitForCondition } from '../lib/test/wait-for-condition';

// Restarting the agent's own container kills the agent process, so the restart
// endpoint must answer before the swap instead of awaiting it.
describe('handleContainerRestart', () => {
  const ORIGINAL = process.env.AGENT_CONTAINER_NAME;

  function cleanup() {
    if (ORIGINAL === undefined) delete process.env.AGENT_CONTAINER_NAME;
    else process.env.AGENT_CONTAINER_NAME = ORIGINAL;
  }

  test('acknowledges a self-restart with 202 and restarts in the background', async () => {
    process.env.AGENT_CONTAINER_NAME = 'hlm-agent';
    try {
      const restart = mock(() => new Promise<void>(() => {})); // never settles: the swap is in flight
      const docker = { getContainer: mock(() => ({ restart })) };
      const response = await handleContainerRestart(docker as never, 'hlm-agent', {} as Request);
      expect(response.status).toBe(202);
      // The background restart is kicked off before the response resolves, not awaited.
      expect(docker.getContainer).toHaveBeenCalledWith('hlm-agent');
      expect(restart).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  test('awaits a foreign container restart and answers with the control result', async () => {
    process.env.AGENT_CONTAINER_NAME = 'hlm-agent';
    try {
      const restart = mock(() => Promise.resolve());
      const docker = { getContainer: mock(() => ({ restart })) };
      const response = await handleContainerRestart(docker as never, 'some-other-container', {} as Request);
      expect(response.status).toBe(200);
      expect(restart).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  test('treats an unset AGENT_CONTAINER_NAME as the contractual hlm-agent default', async () => {
    delete process.env.AGENT_CONTAINER_NAME;
    try {
      const restart = mock(() => new Promise<void>(() => {}));
      const docker = { getContainer: mock(() => ({ restart })) };
      const response = await handleContainerRestart(docker as never, 'hlm-agent', {} as Request);
      expect(response.status).toBe(202);
      expect(restart).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  test('still acknowledges 202 when the background self-restart fails', async () => {
    process.env.AGENT_CONTAINER_NAME = 'hlm-agent';
    try {
      const restart = mock(() => Promise.reject(new Error('docker daemon down')));
      const docker = { getContainer: mock(() => ({ restart })) };
      const response = await handleContainerRestart(docker as never, 'hlm-agent', {} as Request);
      expect(response.status).toBe(202);
      // The rejection is caught inside controlContainer and by the background call's .catch.
      expect(restart).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });
});

describe('container control error mapping and wrappers', () => {
  const ORIGINAL = process.env.AGENT_CONTAINER_NAME;

  function cleanup() {
    if (ORIGINAL === undefined) delete process.env.AGENT_CONTAINER_NAME;
    else process.env.AGENT_CONTAINER_NAME = ORIGINAL;
  }

  test('a foreign container restart rejection with statusCode 404 maps to 404 Container not found', async () => {
    process.env.AGENT_CONTAINER_NAME = 'hlm-agent';
    try {
      const restart = mock(() => Promise.reject(Object.assign(new Error('no such container'), { statusCode: 404 })));
      const docker = { getContainer: mock(() => ({ restart })) };
      const response = await handleContainerRestart(docker as never, 'ghost-container', {} as Request);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Container not found: ghost-container' });
    } finally {
      cleanup();
    }
  });

  test('an already-in-state restart rejection maps to 409 with the docker error message', async () => {
    process.env.AGENT_CONTAINER_NAME = 'hlm-agent';
    try {
      const restart = mock(() => Promise.reject(Object.assign(new Error('container already restarting'), { statusCode: 304 })));
      const docker = { getContainer: mock(() => ({ restart })) };
      const response = await handleContainerRestart(docker as never, 'some-other-container', {} as Request);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'container already restarting' });
    } finally {
      cleanup();
    }
  });

  test('handleContainerStart returns success when the container starts', async () => {
    const start = mock(() => Promise.resolve());
    const docker = { getContainer: mock(() => ({ start })) };
    const response = await handleContainerStart(docker as never, 'web', {} as Request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'success' });
    expect(docker.getContainer).toHaveBeenCalledWith('web');
  });

  test('handleContainerStop returns success when the container stops', async () => {
    const stop = mock(() => Promise.resolve());
    const docker = { getContainer: mock(() => ({ stop })) };
    const response = await handleContainerStop(docker as never, 'web', {} as Request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'success' });
    expect(docker.getContainer).toHaveBeenCalledWith('web');
  });

  test('a self-restart rejection that escapes controlContainer is logged by the background catch', async () => {
    process.env.AGENT_CONTAINER_NAME = 'hlm-agent';
    const seen: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { seen.push(args); };
    try {
      // A malformed rejection escapes controlContainer's catch, so only the background .catch sees it.
      const boom = new Error('disk on fire');
      Object.defineProperty(boom, 'message', { get() { throw new TypeError('unreadable message'); } });
      const restart = mock(() => Promise.reject(boom));
      const docker = { getContainer: mock(() => ({ restart })) };
      const response = await handleContainerRestart(docker as never, 'hlm-agent', {} as Request);
      expect(response.status).toBe(202);
      await waitForCondition(() => seen.length > 0, { timeoutMs: 2000 });
      expect(String(seen[0]?.[0])).toContain('Self-restart');
    } finally {
      console.error = originalError;
      cleanup();
    }
  });
});
