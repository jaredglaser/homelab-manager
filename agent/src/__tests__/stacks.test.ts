import { describe, expect, test, mock, beforeAll, beforeEach, afterEach } from 'bun:test';
import {
  handleStackDeploy,
  handleStackTeardown,
  handleStackRestart,
  handleStackStart,
  handleStackStop,
  handleStackStatus,
  parseContainerNames,
} from '../routes/stacks';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

beforeAll(() => {
  console.error = mock(() => {});
});

const TEST_STACKS_DIR = join(import.meta.dir, '../../.test-stacks');

const emptyStream = () => new ReadableStream({ start(c) { c.close(); } });

const successSpawn = mock(() => ({
  exited: Promise.resolve(0),
  stdout: emptyStream(),
  stderr: emptyStream(),
}));

beforeEach(() => {
  successSpawn.mockClear();
  mkdirSync(TEST_STACKS_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_STACKS_DIR, { recursive: true, force: true });
});

describe('handleStackDeploy', () => {
  test('returns 400 for invalid JSON body', async () => {
    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(400);
    const result = await response.json();
    expect(result.error).toStartWith('Invalid JSON:');
  });

  test('rejects null JSON body', async () => {
    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(null),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(400);
    const result = await response.json();
    expect(result.error).toBe('Request body must be a JSON object');
  });

  test('writes compose file and .env to stack directory', async () => {
    const mockSpawn = mock(() => ({
      exited: Promise.resolve(0),
      stdout: emptyStream(),
      stderr: emptyStream(),
    }));

    const body = {
      stack: 'plex',
      composeContent: 'services:\n  plex:\n    image: plexinc/pms-docker',
      envContent: 'PLEX_CLAIM=claim-abc123',
    };

    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, mockSpawn as any);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.status).toBe('success');

    const composePath = join(TEST_STACKS_DIR, 'plex', 'docker-compose.yml');
    expect(existsSync(composePath)).toBe(true);
    expect(readFileSync(composePath, 'utf-8')).toBe(body.composeContent);

    const envPath = join(TEST_STACKS_DIR, 'plex', '.env');
    expect(existsSync(envPath)).toBe(true);
    expect(readFileSync(envPath, 'utf-8')).toBe(body.envContent);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: ['docker', 'compose', '-f', composePath, 'up', '-d', '--remove-orphans'],
        cwd: join(TEST_STACKS_DIR, 'plex'),
        env: expect.objectContaining({ COMPOSE_PROJECT_NAME: 'plex' }),
      })
    );
  });

  test('returns 400 for missing stack name', async () => {
    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ composeContent: 'services: {}' }),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(400);
  });

  test('returns 500 when docker compose fails', async () => {
    const mockSpawn = mock(() => ({
      exited: Promise.resolve(1),
      stdout: emptyStream(),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('Error: image not found'));
          controller.close();
        },
      }),
    }));

    const body = {
      stack: 'plex',
      composeContent: 'services:\n  plex:\n    image: invalid',
    };

    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, mockSpawn as any);
    expect(response.status).toBe(500);
  });
});

describe('handleStackDeploy: type validation', () => {
  test('returns 400 when stack is not a string', async () => {
    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 123, composeContent: 'services: {}' }),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(400);
    const result = await response.json();
    expect(result.error).toContain('must be strings');
  });

  test('returns 400 when envContent is not a string', async () => {
    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'plex', composeContent: 'services: {}', envContent: 42 }),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(400);
    const result = await response.json();
    expect(result.error).toContain('envContent must be a string');
  });

  test('returns 400 when forceRecreate is not a boolean', async () => {
    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'plex', composeContent: 'services: {}', forceRecreate: 'yes' }),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(400);
    const result = await response.json();
    expect(result.error).toContain('forceRecreate must be a boolean');
  });
});

describe('handleStackDeploy: payload size limits', () => {
  test('returns 413 for oversized composeContent', async () => {
    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'plex', composeContent: 'x'.repeat(1_048_577) }),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(413);
    const result = await response.json();
    expect(result.error).toBe('composeContent too large');
  });

  test('returns 413 for oversized envContent', async () => {
    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'plex', composeContent: 'services: {}', envContent: 'x'.repeat(65_537) }),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(413);
    const result = await response.json();
    expect(result.error).toBe('envContent too large');
  });
});

describe('handleStackDeploy: path traversal', () => {
  test('rejects stack names with path traversal', async () => {
    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: '../../etc', composeContent: 'services: {}' }),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(400);
  });

  test('rejects stack names with dots', async () => {
    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: '.hidden', composeContent: 'services: {}' }),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(400);
  });

  test('returns 400 with "Invalid stack path" when resolved path escapes stacksDir', async () => {
    // Passing stacksDir with a trailing slash causes join() to normalize it, so
    // join('/dir/', 'stack') = '/dir/stack' which does not start with '/dir//'
    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'mystack', composeContent: 'services: {}' }),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR + '/', successSpawn as any);
    expect(response.status).toBe(400);
    const result = await response.json();
    expect(result.error).toBe('Invalid stack path');
  });
});

describe('handleStackDeploy: file write failure', () => {
  test('returns 500 when writing stack files fails', async () => {
    // Create a file where the stack directory should be, so mkdirSync fails
    await Bun.write(join(TEST_STACKS_DIR, 'plex'), 'not a directory');

    const body = {
      stack: 'plex',
      composeContent: 'services:\n  plex:\n    image: nginx',
    };

    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(500);
    const result = await response.json();
    expect(result.error).toContain('Failed to write stack files');
  });
});

describe('handleStackDeploy: subprocess timeout', () => {
  test('returns 500 with timeout message when subprocess exceeds deadline', async () => {
    let resolveExited: (code: number) => void;
    const hangingSpawn = mock(() => ({
      exited: new Promise<number>((resolve) => { resolveExited = resolve; }),
      stdout: emptyStream(),
      stderr: emptyStream(),
      kill: mock(() => { resolveExited(137); }),
    }));

    const body = {
      stack: 'slow',
      composeContent: 'services:\n  slow:\n    image: nginx',
    };

    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, hangingSpawn as any, 10);
    const result = await response.json();

    expect(response.status).toBe(500);
    expect(result.status).toBe('failed');
    expect(result.stderr).toContain('timed out');
  });
});

describe('handleStackDeploy: spawn failure', () => {
  test('returns 500 with detail when spawn throws', async () => {
    const throwSpawn = mock(() => { throw new Error('docker: not found'); });

    const body = {
      stack: 'plex',
      composeContent: 'services:\n  plex:\n    image: nginx',
    };

    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, throwSpawn as any);
    expect(response.status).toBe(500);
    const result = await response.json();
    expect(result.error).toContain('Failed to execute docker compose');
    expect(result.error).toContain('docker: not found');
  });
});

describe('handleStackTeardown', () => {
  test('returns 400 for invalid JSON body', async () => {
    const request = new Request('http://localhost/stacks/teardown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });

    const response = await handleStackTeardown(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(400);
    const result = await response.json();
    expect(result.error).toStartWith('Invalid JSON:');
  });

  test('returns 400 for missing stack name', async () => {
    const request = new Request('http://localhost/stacks/teardown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const response = await handleStackTeardown(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(400);
  });

  test('returns 404 for nonexistent stack', async () => {
    const request = new Request('http://localhost/stacks/teardown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'nonexistent' }),
    });

    const response = await handleStackTeardown(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(404);
  });

  test('runs docker compose down for existing stack', async () => {
    mkdirSync(join(TEST_STACKS_DIR, 'plex'), { recursive: true });
    await Bun.write(join(TEST_STACKS_DIR, 'plex', 'docker-compose.yml'), 'services: {}');

    const request = new Request('http://localhost/stacks/teardown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'plex' }),
    });

    const response = await handleStackTeardown(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.status).toBe('success');

    expect(successSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: ['docker', 'compose', '-f', join(TEST_STACKS_DIR, 'plex', 'docker-compose.yml'), 'down'],
        cwd: join(TEST_STACKS_DIR, 'plex'),
        env: expect.objectContaining({ COMPOSE_PROJECT_NAME: 'plex' }),
      })
    );
  });

  test('returns 500 when docker compose down fails', async () => {
    mkdirSync(join(TEST_STACKS_DIR, 'plex'), { recursive: true });
    await Bun.write(join(TEST_STACKS_DIR, 'plex', 'docker-compose.yml'), 'services: {}');

    const failSpawn = mock(() => ({
      exited: Promise.resolve(1),
      stdout: emptyStream(),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('Error: compose down failed'));
          controller.close();
        },
      }),
    }));

    const request = new Request('http://localhost/stacks/teardown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'plex' }),
    });

    const response = await handleStackTeardown(request, TEST_STACKS_DIR, failSpawn as any);
    expect(response.status).toBe(500);
    const result = await response.json();
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(1);
  });
});

describe('handleStackTeardown: path traversal', () => {
  test('returns 400 with "Invalid stack path" when resolved path escapes stacksDir', async () => {
    const request = new Request('http://localhost/stacks/teardown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'mystack' }),
    });

    const response = await handleStackTeardown(request, TEST_STACKS_DIR + '/', successSpawn as any);
    expect(response.status).toBe(400);
    const result = await response.json();
    expect(result.error).toBe('Invalid stack path');
  });
});

describe('handleStackTeardown: subprocess timeout', () => {
  test('returns 500 with timeout message when subprocess exceeds deadline', async () => {
    mkdirSync(join(TEST_STACKS_DIR, 'plex'), { recursive: true });
    await Bun.write(join(TEST_STACKS_DIR, 'plex', 'docker-compose.yml'), 'services: {}');

    let resolveExited: (code: number) => void;
    const hangingSpawn = mock(() => ({
      exited: new Promise<number>((resolve) => { resolveExited = resolve; }),
      stdout: emptyStream(),
      stderr: emptyStream(),
      kill: mock(() => { resolveExited(137); }),
    }));

    const request = new Request('http://localhost/stacks/teardown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'plex' }),
    });

    const response = await handleStackTeardown(request, TEST_STACKS_DIR, hangingSpawn as any, 10);
    const result = await response.json();

    expect(response.status).toBe(500);
    expect(result.status).toBe('failed');
    expect(result.stderr).toContain('timed out');
  });
});

describe('handleStackTeardown: spawn failure', () => {
  test('returns 500 with detail when spawn throws', async () => {
    mkdirSync(join(TEST_STACKS_DIR, 'plex'), { recursive: true });
    await Bun.write(join(TEST_STACKS_DIR, 'plex', 'docker-compose.yml'), 'services: {}');

    const throwSpawn = mock(() => { throw new Error('ENOENT'); });

    const request = new Request('http://localhost/stacks/teardown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'plex' }),
    });

    const response = await handleStackTeardown(request, TEST_STACKS_DIR, throwSpawn as any);
    expect(response.status).toBe(500);
    const result = await response.json();
    expect(result.error).toContain('Failed to execute docker compose');
  });
});

describe('handleStackRestart', () => {
  test('returns 400 for invalid JSON body', async () => {
    const request = new Request('http://localhost/stacks/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });

    const response = await handleStackRestart(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(400);
    const result = await response.json();
    expect(result.error).toStartWith('Invalid JSON:');
  });

  test('returns 400 for missing stack name', async () => {
    const request = new Request('http://localhost/stacks/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const response = await handleStackRestart(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(400);
  });

  test('returns 404 for nonexistent stack', async () => {
    const request = new Request('http://localhost/stacks/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'nonexistent', scope: 'stack' }),
    });

    const response = await handleStackRestart(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(404);
  });

  test('runs docker compose restart for existing stack', async () => {
    mkdirSync(join(TEST_STACKS_DIR, 'traefik'), { recursive: true });
    await Bun.write(join(TEST_STACKS_DIR, 'traefik', 'docker-compose.yml'), 'services: {}');

    const request = new Request('http://localhost/stacks/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'traefik', scope: 'stack' }),
    });

    const response = await handleStackRestart(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.status).toBe('success');

    expect(successSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: ['docker', 'compose', '-f', join(TEST_STACKS_DIR, 'traefik', 'docker-compose.yml'), 'restart'],
        cwd: join(TEST_STACKS_DIR, 'traefik'),
        env: expect.objectContaining({ COMPOSE_PROJECT_NAME: 'traefik' }),
      })
    );
  });

  test('returns 500 when docker compose restart fails', async () => {
    mkdirSync(join(TEST_STACKS_DIR, 'traefik'), { recursive: true });
    await Bun.write(join(TEST_STACKS_DIR, 'traefik', 'docker-compose.yml'), 'services: {}');

    const failSpawn = mock(() => ({
      exited: Promise.resolve(1),
      stdout: emptyStream(),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('Error: compose restart failed'));
          controller.close();
        },
      }),
    }));

    const request = new Request('http://localhost/stacks/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'traefik', scope: 'stack' }),
    });

    const response = await handleStackRestart(request, TEST_STACKS_DIR, failSpawn as any);
    expect(response.status).toBe(500);
    const result = await response.json();
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(1);
  });

  test('appends service name when scope is service', async () => {
    const stackDir = join(TEST_STACKS_DIR, 'myapp');
    mkdirSync(stackDir, { recursive: true });
    await Bun.write(join(stackDir, 'docker-compose.yml'), 'services:\n  web:\n    image: nginx\n');

    const request = new Request('http://localhost/stacks/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'myapp', scope: 'service', service: 'web' }),
    });
    const response = await handleStackRestart(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(200);
    const cmd = successSpawn.mock.calls[0][0].cmd as string[];
    expect(cmd).toContain('restart');
    expect(cmd).toContain('web');
  });

  test('runs on whole stack when scope is stack', async () => {
    const stackDir = join(TEST_STACKS_DIR, 'myapp');
    mkdirSync(stackDir, { recursive: true });
    await Bun.write(join(stackDir, 'docker-compose.yml'), 'services:\n  web:\n    image: nginx\n');

    const request = new Request('http://localhost/stacks/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'myapp', scope: 'stack' }),
    });
    const response = await handleStackRestart(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(200);
    const cmd = successSpawn.mock.calls[0][0].cmd as string[];
    expect(cmd).toContain('restart');
    expect(cmd).not.toContain('web');
  });
});

describe('handleStackRestart: path traversal', () => {
  test('returns 400 with "Invalid stack path" when resolved path escapes stacksDir', async () => {
    const request = new Request('http://localhost/stacks/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'mystack', scope: 'stack' }),
    });

    const response = await handleStackRestart(request, TEST_STACKS_DIR + '/', successSpawn as any);
    expect(response.status).toBe(400);
    const result = await response.json();
    expect(result.error).toBe('Invalid stack path');
  });
});

describe('handleStackRestart: subprocess timeout', () => {
  test('returns 500 with timeout message when subprocess exceeds deadline', async () => {
    mkdirSync(join(TEST_STACKS_DIR, 'traefik'), { recursive: true });
    await Bun.write(join(TEST_STACKS_DIR, 'traefik', 'docker-compose.yml'), 'services: {}');

    let resolveExited: (code: number) => void;
    const hangingSpawn = mock(() => ({
      exited: new Promise<number>((resolve) => { resolveExited = resolve; }),
      stdout: emptyStream(),
      stderr: emptyStream(),
      kill: mock(() => { resolveExited(137); }),
    }));

    const request = new Request('http://localhost/stacks/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'traefik', scope: 'stack' }),
    });

    const response = await handleStackRestart(request, TEST_STACKS_DIR, hangingSpawn as any, 10);
    const result = await response.json();

    expect(response.status).toBe(500);
    expect(result.status).toBe('failed');
    expect(result.stderr).toContain('timed out');
  });
});

describe('handleStackRestart: spawn failure', () => {
  test('returns 500 with detail when spawn throws', async () => {
    mkdirSync(join(TEST_STACKS_DIR, 'traefik'), { recursive: true });
    await Bun.write(join(TEST_STACKS_DIR, 'traefik', 'docker-compose.yml'), 'services: {}');

    const throwSpawn = mock(() => { throw new Error('EACCES'); });

    const request = new Request('http://localhost/stacks/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'traefik', scope: 'stack' }),
    });

    const response = await handleStackRestart(request, TEST_STACKS_DIR, throwSpawn as any);
    expect(response.status).toBe(500);
    const result = await response.json();
    expect(result.error).toContain('Failed to execute docker compose');
  });
});

describe('handleStackDeploy: without envContent', () => {
  test('deploys stack without creating .env file when envContent is absent', async () => {
    const mockSpawn = mock(() => ({
      exited: Promise.resolve(0),
      stdout: emptyStream(),
      stderr: emptyStream(),
    }));

    const body = {
      stack: 'nginx',
      composeContent: 'services:\n  nginx:\n    image: nginx',
    };

    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, mockSpawn as any);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.status).toBe('success');

    const composePath = join(TEST_STACKS_DIR, 'nginx', 'docker-compose.yml');
    expect(existsSync(composePath)).toBe(true);

    const envPath = join(TEST_STACKS_DIR, 'nginx', '.env');
    expect(existsSync(envPath)).toBe(false);
  });
});

describe('handleStackStatus', () => {
  test('returns stack with container details', async () => {
    mkdirSync(join(TEST_STACKS_DIR, 'plex'), { recursive: true });
    await Bun.write(join(TEST_STACKS_DIR, 'plex', 'docker-compose.yml'), 'services: {}');

    const containers = [{ Name: 'plex-app-1', State: 'running', Service: 'app' }];
    const statusSpawn = mock(() => ({
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(containers)));
          controller.close();
        },
      }),
      stderr: emptyStream(),
    }));

    const response = await handleStackStatus(TEST_STACKS_DIR, statusSpawn as any);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.stacks).toHaveLength(1);
    expect(result.stacks[0].name).toBe('plex');
    expect(result.stacks[0].containers).toEqual(containers);
  });

  test('returns empty array for nonexistent stacks directory', async () => {
    rmSync(TEST_STACKS_DIR, { recursive: true, force: true });

    const response = await handleStackStatus(TEST_STACKS_DIR, successSpawn as any);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.stacks).toEqual([]);
  });

  test('skips directories without docker-compose.yml', async () => {
    mkdirSync(join(TEST_STACKS_DIR, 'no-compose'), { recursive: true });
    mkdirSync(join(TEST_STACKS_DIR, 'has-compose'), { recursive: true });
    await Bun.write(join(TEST_STACKS_DIR, 'has-compose', 'docker-compose.yml'), 'services: {}');

    const response = await handleStackStatus(TEST_STACKS_DIR, successSpawn as any);
    const result = await response.json();

    expect(result.stacks).toHaveLength(1);
    expect(result.stacks[0].name).toBe('has-compose');
  });

  test('parses NDJSON output from docker compose ps', async () => {
    mkdirSync(join(TEST_STACKS_DIR, 'multi'), { recursive: true });
    await Bun.write(join(TEST_STACKS_DIR, 'multi', 'docker-compose.yml'), 'services: {}');

    const container1 = { Name: 'multi-web-1', State: 'running', Service: 'web' };
    const container2 = { Name: 'multi-db-1', State: 'running', Service: 'db' };
    const ndjson = JSON.stringify(container1) + '\n' + JSON.stringify(container2);

    const ndjsonSpawn = mock(() => ({
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(ndjson));
          controller.close();
        },
      }),
      stderr: emptyStream(),
    }));

    const response = await handleStackStatus(TEST_STACKS_DIR, ndjsonSpawn as any);
    const result = await response.json();

    expect(result.stacks).toHaveLength(1);
    expect(result.stacks[0].containers).toEqual([container1, container2]);
  });

  test('returns empty containers when docker compose ps fails', async () => {
    mkdirSync(join(TEST_STACKS_DIR, 'broken'), { recursive: true });
    await Bun.write(join(TEST_STACKS_DIR, 'broken', 'docker-compose.yml'), 'services: {}');

    const failSpawn = mock(() => ({
      exited: Promise.resolve(1),
      stdout: emptyStream(),
      stderr: emptyStream(),
    }));

    const response = await handleStackStatus(TEST_STACKS_DIR, failSpawn as any);
    const result = await response.json();

    expect(result.stacks).toHaveLength(1);
    expect(result.stacks[0].name).toBe('broken');
    expect(result.stacks[0].containers).toEqual([]);
    expect(result.hasErrors).toBe(true);
  });

  test('sets hasErrors when any stack has an error', async () => {
    mkdirSync(join(TEST_STACKS_DIR, 'good'), { recursive: true });
    await Bun.write(join(TEST_STACKS_DIR, 'good', 'docker-compose.yml'), 'services: {}');
    mkdirSync(join(TEST_STACKS_DIR, 'bad'), { recursive: true });
    await Bun.write(join(TEST_STACKS_DIR, 'bad', 'docker-compose.yml'), 'services: {}');

    let callIdx = 0;
    const mixedSpawn = mock(() => {
      callIdx++;
      if (callIdx === 1) {
        return {
          exited: Promise.resolve(0),
          stdout: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('[]')); c.close(); } }),
          stderr: emptyStream(),
        };
      }
      return {
        exited: Promise.resolve(1),
        stdout: emptyStream(),
        stderr: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('compose error')); c.close(); } }),
      };
    });

    const response = await handleStackStatus(TEST_STACKS_DIR, mixedSpawn as any);
    const result = await response.json();

    expect(result.hasErrors).toBe(true);
    const errStack = result.stacks.find((s: any) => s.error);
    expect(errStack).toBeDefined();
  });

  test('does not set hasErrors when all stacks succeed', async () => {
    mkdirSync(join(TEST_STACKS_DIR, 'ok'), { recursive: true });
    await Bun.write(join(TEST_STACKS_DIR, 'ok', 'docker-compose.yml'), 'services: {}');

    const okSpawn = mock(() => ({
      exited: Promise.resolve(0),
      stdout: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('[]')); c.close(); } }),
      stderr: emptyStream(),
    }));

    const response = await handleStackStatus(TEST_STACKS_DIR, okSpawn as any);
    const result = await response.json();

    expect(result.hasErrors).toBeUndefined();
  });

  test('returns error when docker compose ps times out', async () => {
    mkdirSync(join(TEST_STACKS_DIR, 'slow'), { recursive: true });
    await Bun.write(join(TEST_STACKS_DIR, 'slow', 'docker-compose.yml'), 'services: {}');

    let resolveExited: (code: number) => void;
    const hangingSpawn = mock(() => ({
      exited: new Promise<number>((resolve) => { resolveExited = resolve; }),
      stdout: emptyStream(),
      stderr: emptyStream(),
      kill: mock(() => { resolveExited(137); }),
    }));

    const response = await handleStackStatus(TEST_STACKS_DIR, hangingSpawn as any, 10);
    const result = await response.json();

    expect(result.stacks).toHaveLength(1);
    expect(result.stacks[0].name).toBe('slow');
    expect(result.stacks[0].containers).toEqual([]);
    expect(result.stacks[0].error).toContain('timed out');
    expect(result.hasErrors).toBe(true);
  });

  test('returns error when spawn throws', async () => {
    mkdirSync(join(TEST_STACKS_DIR, 'crash'), { recursive: true });
    await Bun.write(join(TEST_STACKS_DIR, 'crash', 'docker-compose.yml'), 'services: {}');

    const throwSpawn = mock(() => { throw new Error('docker: not found'); });

    const response = await handleStackStatus(TEST_STACKS_DIR, throwSpawn as any);
    const result = await response.json();

    expect(result.stacks).toHaveLength(1);
    expect(result.stacks[0].name).toBe('crash');
    expect(result.stacks[0].containers).toEqual([]);
    expect(result.stacks[0].error).toContain('docker: not found');
    expect(result.hasErrors).toBe(true);
  });

  test('returns error for completely unparseable output', async () => {
    mkdirSync(join(TEST_STACKS_DIR, 'garbled'), { recursive: true });
    await Bun.write(join(TEST_STACKS_DIR, 'garbled', 'docker-compose.yml'), 'services: {}');

    const garbageSpawn = mock(() => ({
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('not json at all\nstill not json'));
          controller.close();
        },
      }),
      stderr: emptyStream(),
    }));

    const response = await handleStackStatus(TEST_STACKS_DIR, garbageSpawn as any);
    const result = await response.json();

    expect(result.stacks).toHaveLength(1);
    expect(result.stacks[0].name).toBe('garbled');
    expect(result.stacks[0].error).toBe('Failed to parse status output');
    expect(result.stacks[0].containers).toEqual([]);
    expect(result.hasErrors).toBe(true);
  });

  test('skips directories with invalid names', async () => {
    mkdirSync(join(TEST_STACKS_DIR, '.hidden'), { recursive: true });
    await Bun.write(join(TEST_STACKS_DIR, '.hidden', 'docker-compose.yml'), 'services: {}');
    mkdirSync(join(TEST_STACKS_DIR, 'valid-stack'), { recursive: true });
    await Bun.write(join(TEST_STACKS_DIR, 'valid-stack', 'docker-compose.yml'), 'services: {}');

    const response = await handleStackStatus(TEST_STACKS_DIR, successSpawn as any);
    const result = await response.json();

    expect(result.stacks).toHaveLength(1);
    expect(result.stacks[0].name).toBe('valid-stack');
  });

  test('returns 500 when stacks directory is unreadable', async () => {
    // Use a path that exists but isn't a directory (a regular file)
    const filePath = join(TEST_STACKS_DIR, 'not-a-dir');
    await Bun.write(filePath, 'file');

    const response = await handleStackStatus(filePath, successSpawn as any);
    expect(response.status).toBe(500);
    const result = await response.json();
    expect(result.error).toContain('Failed to read stacks directory');
  });

  test('runs status checks concurrently', async () => {
    mkdirSync(join(TEST_STACKS_DIR, 'a-stack'), { recursive: true });
    await Bun.write(join(TEST_STACKS_DIR, 'a-stack', 'docker-compose.yml'), 'services: {}');
    mkdirSync(join(TEST_STACKS_DIR, 'b-stack'), { recursive: true });
    await Bun.write(join(TEST_STACKS_DIR, 'b-stack', 'docker-compose.yml'), 'services: {}');

    const startTimes: number[] = [];
    const delayedSpawn = mock(() => {
      startTimes.push(Date.now());
      return {
        exited: new Promise<number>((r) => setTimeout(() => r(0), 50)),
        stdout: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('[]')); c.close(); } }),
        stderr: emptyStream(),
      };
    });

    const start = Date.now();
    const response = await handleStackStatus(TEST_STACKS_DIR, delayedSpawn as any);
    const elapsed = Date.now() - start;
    const result = await response.json();

    expect(result.stacks).toHaveLength(2);
    // If concurrent, both spawns start nearly simultaneously and total time ≈ 50ms
    // If sequential, total time ≈ 100ms
    expect(elapsed).toBeLessThan(90);
  });
});

describe('parseContainerNames', () => {
  test('extracts container_name values', () => {
    const compose = `services:
  web:
    container_name: my-web
    image: nginx
  db:
    container_name: my-db
    image: postgres`;
    expect(parseContainerNames(compose)).toEqual(['my-web', 'my-db']);
  });

  test('handles quoted container names', () => {
    const compose = `services:
  app:
    container_name: "my-app"`;
    expect(parseContainerNames(compose)).toEqual(['my-app']);
  });

  test('handles single-quoted container names', () => {
    const compose = `services:
  app:
    container_name: 'my-app'`;
    expect(parseContainerNames(compose)).toEqual(['my-app']);
  });

  test('returns empty array when no container_name is present', () => {
    const compose = `services:
  app:
    image: nginx`;
    expect(parseContainerNames(compose)).toEqual([]);
  });

  test('returns the literal string for container names with unresolved env var syntax', () => {
    // parseContainerNames does simple regex extraction; it does not interpolate
    // env vars. Resolution happens upstream in handleStackDeploy via
    // `docker compose config` before this function is called during force-recreate.
    const compose = `services:
  web:
    container_name: \${APP_NAME}-web`;
    expect(parseContainerNames(compose)).toEqual(['${APP_NAME}-web']);
  });
});

describe('handleStackDeploy: force recreate', () => {
  test('runs docker rm -f for each container_name then docker compose up --force-recreate', async () => {
    const spawnCalls: { cmd: string[] }[] = [];
    const trackingSpawn = mock((opts: any) => {
      spawnCalls.push({ cmd: opts.cmd });
      return {
        exited: Promise.resolve(0),
        stdout: emptyStream(),
        stderr: emptyStream(),
      };
    });

    const body = {
      stack: 'myapp',
      composeContent: `services:
  web:
    container_name: myapp-web
    image: nginx
  db:
    container_name: myapp-db
    image: postgres`,
      forceRecreate: true,
    };

    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, trackingSpawn as any);
    expect(response.status).toBe(200);

    // Should have called docker rm -f for each container_name
    const rmCalls = spawnCalls.filter(c => c.cmd.includes('rm'));
    expect(rmCalls).toHaveLength(2);
    expect(rmCalls[0].cmd).toEqual(['docker', 'rm', '-f', 'myapp-web']);
    expect(rmCalls[1].cmd).toEqual(['docker', 'rm', '-f', 'myapp-db']);

    // Final compose up should include --force-recreate
    const upCall = spawnCalls.find(c => c.cmd.includes('up'));
    expect(upCall).toBeDefined();
    expect(upCall!.cmd).toContain('--force-recreate');
  });

  test('uses resolved container names from docker compose config when force recreating', async () => {
    const spawnCalls: { cmd: string[] }[] = [];
    const trackingSpawn = mock((opts: any) => {
      spawnCalls.push({ cmd: opts.cmd });
      // Return resolved YAML from `docker compose config`
      if (opts.cmd.includes('config')) {
        const resolvedYaml = `services:
  web:
    container_name: myapp-web
    image: nginx`;
        return {
          exited: Promise.resolve(0),
          stdout: new ReadableStream({
            start(c) { c.enqueue(new TextEncoder().encode(resolvedYaml)); c.close(); },
          }),
          stderr: emptyStream(),
        };
      }
      return {
        exited: Promise.resolve(0),
        stdout: emptyStream(),
        stderr: emptyStream(),
      };
    });

    const body = {
      stack: 'myapp',
      composeContent: `services:
  web:
    container_name: \${APP_NAME}-web
    image: nginx`,
      forceRecreate: true,
    };

    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, trackingSpawn as any);
    expect(response.status).toBe(200);

    // docker rm -f should target the resolved name, not the literal placeholder
    const rmCalls = spawnCalls.filter(c => c.cmd.includes('rm'));
    expect(rmCalls).toHaveLength(1);
    expect(rmCalls[0].cmd).toEqual(['docker', 'rm', '-f', 'myapp-web']);
  });

  test('falls back to raw compose content when docker compose config fails', async () => {
    const spawnCalls: { cmd: string[] }[] = [];
    const trackingSpawn = mock((opts: any) => {
      spawnCalls.push({ cmd: opts.cmd });
      // Simulate docker compose config failure
      if (opts.cmd.includes('config')) {
        return {
          exited: Promise.resolve(1),
          stdout: emptyStream(),
          stderr: new ReadableStream({
            start(c) { c.enqueue(new TextEncoder().encode('error: config failed')); c.close(); },
          }),
        };
      }
      return {
        exited: Promise.resolve(0),
        stdout: emptyStream(),
        stderr: emptyStream(),
      };
    });

    const body = {
      stack: 'myapp',
      composeContent: `services:
  web:
    container_name: myapp-web
    image: nginx`,
      forceRecreate: true,
    };

    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, trackingSpawn as any);
    expect(response.status).toBe(200);

    // Falls back to raw content; literal name is still used
    const rmCalls = spawnCalls.filter(c => c.cmd.includes('rm'));
    expect(rmCalls).toHaveLength(1);
    expect(rmCalls[0].cmd).toEqual(['docker', 'rm', '-f', 'myapp-web']);
  });

  test('does not run docker rm or --force-recreate when forceRecreate is false', async () => {
    const spawnCalls: { cmd: string[] }[] = [];
    const trackingSpawn = mock((opts: any) => {
      spawnCalls.push({ cmd: opts.cmd });
      return {
        exited: Promise.resolve(0),
        stdout: emptyStream(),
        stderr: emptyStream(),
      };
    });

    const body = {
      stack: 'myapp',
      composeContent: `services:
  web:
    container_name: myapp-web
    image: nginx`,
      forceRecreate: false,
    };

    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, trackingSpawn as any);
    expect(response.status).toBe(200);

    // No rm calls
    const rmCalls = spawnCalls.filter(c => c.cmd.includes('rm'));
    expect(rmCalls).toHaveLength(0);

    // No --force-recreate
    const upCall = spawnCalls.find(c => c.cmd.includes('up'));
    expect(upCall).toBeDefined();
    expect(upCall!.cmd).not.toContain('--force-recreate');
  });
});

describe('handleStackStart', () => {
  test('returns 404 when compose file does not exist', async () => {
    const request = new Request('http://localhost/stacks/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'nostack', scope: 'stack' }),
    });
    const response = await handleStackStart(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(404);
  });

  test('runs docker compose start for whole stack when scope is stack', async () => {
    const stackDir = join(TEST_STACKS_DIR, 'myapp');
    mkdirSync(stackDir, { recursive: true });
    await Bun.write(join(stackDir, 'docker-compose.yml'), 'services:\n  web:\n    image: nginx\n');

    const request = new Request('http://localhost/stacks/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'myapp', scope: 'stack' }),
    });
    const response = await handleStackStart(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(200);
    const cmd = successSpawn.mock.calls[0][0].cmd as string[];
    expect(cmd).toContain('start');
    expect(cmd).not.toContain('web');
  });

  test('appends service name when scope is service', async () => {
    const stackDir = join(TEST_STACKS_DIR, 'myapp');
    mkdirSync(stackDir, { recursive: true });
    await Bun.write(join(stackDir, 'docker-compose.yml'), 'services:\n  web:\n    image: nginx\n');

    const request = new Request('http://localhost/stacks/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'myapp', scope: 'service', service: 'web' }),
    });
    const response = await handleStackStart(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(200);
    const cmd = successSpawn.mock.calls[0][0].cmd as string[];
    expect(cmd).toContain('start');
    expect(cmd).toContain('web');
  });

  test('returns 400 when scope is service but service field is missing', async () => {
    const request = new Request('http://localhost/stacks/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'myapp', scope: 'service' }),
    });
    const response = await handleStackStart(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(400);
  });

  test('returns 400 for invalid scope', async () => {
    const request = new Request('http://localhost/stacks/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'myapp', scope: 'container' }),
    });
    const response = await handleStackStart(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(400);
  });
});

describe('handleStackStop', () => {
  test('returns 404 when compose file does not exist', async () => {
    const request = new Request('http://localhost/stacks/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'nostack', scope: 'stack' }),
    });
    const response = await handleStackStop(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(404);
  });

  test('runs docker compose stop for whole stack', async () => {
    const stackDir = join(TEST_STACKS_DIR, 'myapp');
    mkdirSync(stackDir, { recursive: true });
    await Bun.write(join(stackDir, 'docker-compose.yml'), 'services:\n  web:\n    image: nginx\n');

    const request = new Request('http://localhost/stacks/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'myapp', scope: 'stack' }),
    });
    const response = await handleStackStop(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(200);
    const cmd = successSpawn.mock.calls[0][0].cmd as string[];
    expect(cmd).toContain('stop');
    expect(cmd).not.toContain('web');
  });

  test('appends service name when scope is service', async () => {
    const stackDir = join(TEST_STACKS_DIR, 'myapp');
    mkdirSync(stackDir, { recursive: true });
    await Bun.write(join(stackDir, 'docker-compose.yml'), 'services:\n  web:\n    image: nginx\n');

    const request = new Request('http://localhost/stacks/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'myapp', scope: 'service', service: 'db' }),
    });
    const response = await handleStackStop(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(200);
    const cmd = successSpawn.mock.calls[0][0].cmd as string[];
    expect(cmd).toContain('stop');
    expect(cmd).toContain('db');
  });
});
