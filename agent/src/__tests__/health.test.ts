import { describe, expect, test, mock } from 'bun:test';
import { handleHealth } from '../routes/health';

describe('handleHealth', () => {
  test('returns 200 with agent version and status', async () => {
    const mockDocker = {
      version: mock(() =>
        Promise.resolve({
          Version: '24.0.7',
          ApiVersion: '1.43',
        })
      ),
    };

    const response = await handleHealth(mockDocker as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.agentVersion).toBe('0.1.0');
    expect(body.docker.version).toBe('24.0.7');
    expect(body.docker.apiVersion).toBe('1.43');
  });

  test('returns 503 when Docker is unreachable', async () => {
    const mockDocker = {
      version: mock(() => Promise.reject(new Error('Connection refused'))),
    };

    const response = await handleHealth(mockDocker as any);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe('unhealthy');
    expect(body.error).toBe('Connection refused');
  });
});
