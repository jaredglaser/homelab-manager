import { describe, test, expect, mock } from 'bun:test';
import { handleContainerRestart } from '../routes/containers';

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
