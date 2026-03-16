import { describe, expect, test, mock, beforeAll } from 'bun:test';
import { handleHealth } from '../routes/health';
import pkg from '../../package.json';

beforeAll(() => {
  console.error = mock(() => {});
});

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
    expect(body.agentVersion).toBe(pkg.version);
    expect(body.docker.version).toBe('24.0.7');
    expect(body.docker.apiVersion).toBe('1.43');
  });

  test('returns 503 with error message when Docker is unreachable', async () => {
    const mockDocker = {
      version: mock(() => Promise.reject(new Error('Connection refused'))),
    };

    const response = await handleHealth(mockDocker as any);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe('unhealthy');
    expect(body.error).toBe('docker_unreachable');
    expect(body.detail).toBe('Connection refused');
  });
});
