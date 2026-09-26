import { describe, expect, test, mock, beforeAll, afterAll } from 'bun:test';
import { createTriggerHandler, createTriggerState } from '../trigger-server';
import type { AgentUpdater, UpdateCheckResult, UpdateResult } from '../agent-updater';

const originalConsoleInfo = console.info;
const originalConsoleError = console.error;

beforeAll(() => {
  console.info = mock(() => {});
  console.error = mock(() => {});
});

afterAll(() => {
  console.info = originalConsoleInfo;
  console.error = originalConsoleError;
});

function createMockUpdater(overrides: {
  check?: () => Promise<UpdateCheckResult>;
  perform?: () => Promise<UpdateResult>;
} = {}): AgentUpdater {
  return {
    checkForUpdate: overrides.check ?? mock(() => Promise.resolve({ updateAvailable: false })),
    performUpdate: overrides.perform ?? mock(() => Promise.resolve({ success: true })),
  } as unknown as AgentUpdater;
}

function postRequest(): Request {
  return new Request('http://localhost/trigger', { method: 'POST' });
}

function waitFor(cond: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => (cond() ? resolve() : setTimeout(tick, 5));
    tick();
  });
}

describe('createTriggerHandler', () => {
  test('rejects non-POST requests', async () => {
    const handler = createTriggerHandler(createMockUpdater());
    const response = await handler(new Request('http://localhost/trigger', { method: 'GET' }));
    expect(response.status).toBe(405);
  });

  test('returns 200 updateAvailable false when the agent is current', async () => {
    const check = mock(() => Promise.resolve({ updateAvailable: false, currentDigest: 'sha256:a' }));
    const perform = mock(() => Promise.resolve({ success: true }));
    const handler = createTriggerHandler(createMockUpdater({ check, perform }));

    const response = await handler(postRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.updateAvailable).toBe(false);
    expect(perform).not.toHaveBeenCalled();
  });

  test('returns 202 and performs the update asynchronously', async () => {
    const state = createTriggerState();
    let release!: () => void;
    const perform = mock(() => new Promise<UpdateResult>((resolve) => { release = () => resolve({ success: true }); }));
    const check = mock(() => Promise.resolve({ updateAvailable: true, currentDigest: 'sha256:a', remoteDigest: 'sha256:b' }));
    const handler = createTriggerHandler(createMockUpdater({ check, perform }), state);

    const response = await handler(postRequest());
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.started).toBe(true);
    expect(perform).toHaveBeenCalledTimes(1);
    expect(state.updating).toBe(true);

    release();
    await waitFor(() => !state.updating);
    expect(state.updating).toBe(false);
  });

  test('rejects a second trigger while an update is running with 409', async () => {
    const state = createTriggerState();
    let release!: () => void;
    const perform = mock(() => new Promise<UpdateResult>((resolve) => { release = () => resolve({ success: true }); }));
    const check = mock(() => Promise.resolve({ updateAvailable: true }));
    const handler = createTriggerHandler(createMockUpdater({ check, perform }), state);

    const first = await handler(postRequest());
    expect(first.status).toBe(202);

    const second = await handler(postRequest());
    expect(second.status).toBe(409);

    release();
    await waitFor(() => !state.updating);
    expect(state.updating).toBe(false);
  });

  test('returns 500 and clears the busy flag when the check throws', async () => {
    const state = createTriggerState();
    let checkCalls = 0;
    const check = mock(() => {
      checkCalls++;
      return checkCalls === 1
        ? Promise.reject(new Error('registry unreachable'))
        : Promise.resolve({ updateAvailable: false } as UpdateCheckResult);
    });
    const handler = createTriggerHandler(createMockUpdater({ check }), state);

    const response = await handler(postRequest());
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('registry unreachable');
    expect(state.updating).toBe(false);

    const again = await handler(postRequest());
    expect(again.status).toBe(200);
  });
});
