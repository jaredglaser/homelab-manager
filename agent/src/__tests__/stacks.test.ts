import { describe, expect, test, mock, beforeAll, beforeEach, afterEach } from 'bun:test';
import {
  handleStackDeploy,
  handleStackTeardown,
  handleStackRestart,
  handleStackStatus,
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

describe('handleStackDeploy — payload size limits', () => {
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

describe('handleStackDeploy — path traversal', () => {
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
});

describe('handleStackDeploy — file write failure', () => {
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

describe('handleStackDeploy — subprocess timeout', () => {
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

describe('handleStackDeploy — spawn failure', () => {
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

describe('handleStackTeardown — subprocess timeout', () => {
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

describe('handleStackTeardown — spawn failure', () => {
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
      body: JSON.stringify({ stack: 'nonexistent' }),
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
      body: JSON.stringify({ stack: 'traefik' }),
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
      body: JSON.stringify({ stack: 'traefik' }),
    });

    const response = await handleStackRestart(request, TEST_STACKS_DIR, failSpawn as any);
    expect(response.status).toBe(500);
    const result = await response.json();
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(1);
  });
});

describe('handleStackRestart — subprocess timeout', () => {
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
      body: JSON.stringify({ stack: 'traefik' }),
    });

    const response = await handleStackRestart(request, TEST_STACKS_DIR, hangingSpawn as any, 10);
    const result = await response.json();

    expect(response.status).toBe(500);
    expect(result.status).toBe('failed');
    expect(result.stderr).toContain('timed out');
  });
});

describe('handleStackRestart — spawn failure', () => {
  test('returns 500 with detail when spawn throws', async () => {
    mkdirSync(join(TEST_STACKS_DIR, 'traefik'), { recursive: true });
    await Bun.write(join(TEST_STACKS_DIR, 'traefik', 'docker-compose.yml'), 'services: {}');

    const throwSpawn = mock(() => { throw new Error('EACCES'); });

    const request = new Request('http://localhost/stacks/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'traefik' }),
    });

    const response = await handleStackRestart(request, TEST_STACKS_DIR, throwSpawn as any);
    expect(response.status).toBe(500);
    const result = await response.json();
    expect(result.error).toContain('Failed to execute docker compose');
  });
});

describe('handleStackDeploy — without envContent', () => {
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
