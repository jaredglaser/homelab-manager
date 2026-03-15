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

const noopSpawn = mock(() => ({
  exited: Promise.resolve(0),
  stdout: emptyStream(),
  stderr: emptyStream(),
}));

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

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, noopSpawn as any);
    expect(response.status).toBe(400);
    const result = await response.json();
    expect(result.error).toBe('Invalid JSON');
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
  });

  test('returns 400 for missing stack name', async () => {
    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ composeContent: 'services: {}' }),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, noopSpawn as any);
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

describe('handleStackDeploy — path traversal', () => {
  test('rejects stack names with path traversal', async () => {
    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: '../../etc', composeContent: 'services: {}' }),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, noopSpawn as any);
    expect(response.status).toBe(400);
  });

  test('rejects stack names with dots', async () => {
    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: '.hidden', composeContent: 'services: {}' }),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, noopSpawn as any);
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

    const response = await handleStackTeardown(request, TEST_STACKS_DIR, noopSpawn as any);
    expect(response.status).toBe(400);
    const result = await response.json();
    expect(result.error).toBe('Invalid JSON');
  });

  test('returns 400 for missing stack name', async () => {
    const request = new Request('http://localhost/stacks/teardown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const response = await handleStackTeardown(request, TEST_STACKS_DIR, noopSpawn as any);
    expect(response.status).toBe(400);
  });

  test('returns 404 for nonexistent stack', async () => {
    const request = new Request('http://localhost/stacks/teardown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'nonexistent' }),
    });

    const response = await handleStackTeardown(request, TEST_STACKS_DIR, noopSpawn as any);
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

    const response = await handleStackRestart(request, TEST_STACKS_DIR, noopSpawn as any);
    expect(response.status).toBe(400);
    const result = await response.json();
    expect(result.error).toBe('Invalid JSON');
  });

  test('returns 400 for missing stack name', async () => {
    const request = new Request('http://localhost/stacks/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const response = await handleStackRestart(request, TEST_STACKS_DIR, noopSpawn as any);
    expect(response.status).toBe(400);
  });

  test('returns 404 for nonexistent stack', async () => {
    const request = new Request('http://localhost/stacks/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'nonexistent' }),
    });

    const response = await handleStackRestart(request, TEST_STACKS_DIR, noopSpawn as any);
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
  test('returns list of stacks with directories', async () => {
    mkdirSync(join(TEST_STACKS_DIR, 'plex'), { recursive: true });
    await Bun.write(
      join(TEST_STACKS_DIR, 'plex', 'docker-compose.yml'),
      'services: {}'
    );

    const statusSpawn = mock(() => ({
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify([
              { Name: 'plex-app-1', State: 'running', Service: 'app' },
            ]))
          );
          controller.close();
        },
      }),
      stderr: new ReadableStream(),
    }));

    const response = await handleStackStatus(TEST_STACKS_DIR, statusSpawn as any);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.stacks).toBeArray();
  });
});
