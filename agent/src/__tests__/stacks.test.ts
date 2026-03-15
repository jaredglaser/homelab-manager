import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import {
  handleStackDeploy,
  handleStackTeardown,
  handleStackRestart,
  handleStackStatus,
} from '../routes/stacks';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

const TEST_STACKS_DIR = join(import.meta.dir, '../../.test-stacks');

const emptyStream = () => new ReadableStream({ start(c) { c.close(); } });

const successSpawn = mock(() => ({
  exited: Promise.resolve(0),
  stdout: emptyStream(),
  stderr: emptyStream(),
}));

beforeEach(() => {
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
  });
});
