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

function triggerRequest(body: unknown): Request {
  return new Request('http://localhost/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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

  test('returns 400 and does not check when targetImage is a floating tag', async () => {
    const check = mock(() => Promise.resolve({ updateAvailable: false }));
    const handler = createTriggerHandler(createMockUpdater({ check }));
    const state = createTriggerState();

    const response = await handler(triggerRequest({ targetImage: 'ghcr.io/org/agent:latest' }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('digest');
    expect(check).not.toHaveBeenCalled();
    expect(state.updating).toBe(false);
  });

  test('returns 400 when targetImage is present but not a valid sha256 digest', async () => {
    const check = mock(() => Promise.resolve({ updateAvailable: false }));
    const handler = createTriggerHandler(createMockUpdater({ check }));

    const response = await handler(triggerRequest({ targetImage: 'ghcr.io/org/agent@sha256:nothex' }));

    expect(response.status).toBe(400);
    expect(check).not.toHaveBeenCalled();
  });

  test('passes a digest-pinned targetImage through to check and perform', async () => {
    const target = 'ghcr.io/org/agent@sha256:' + 'c'.repeat(64);
    const check = mock(() => Promise.resolve({ updateAvailable: true, currentDigest: 'sha256:a', remoteDigest: target }));
    const perform = mock(() => Promise.resolve({ success: true }));
    const handler = createTriggerHandler(createMockUpdater({ check, perform }));

    const response = await handler(triggerRequest({ targetImage: target }));

    expect(response.status).toBe(202);
    expect(check).toHaveBeenCalledWith(target);
    expect(perform).toHaveBeenCalledWith(target);
  });

  test('keeps the legacy floating-tag path when the body carries no targetImage', async () => {
    const check = mock(() => Promise.resolve({ updateAvailable: false }));
    const handler = createTriggerHandler(createMockUpdater({ check }));

    const response = await handler(postRequest());

    expect(response.status).toBe(200);
    expect(check).toHaveBeenCalledWith(undefined);
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

  test('logs the triggered update outcome on success and failure', async () => {
    const state = createTriggerState();
    let release!: () => void;
    const perform = mock(() => new Promise<UpdateResult>((resolve) => {
      release = () => resolve({ success: true, previousImage: 'img:1', newImage: 'img:2' });
    }));
    const check = mock(() => Promise.resolve({ updateAvailable: true }));
    const handler = createTriggerHandler(createMockUpdater({ check, perform }), state);

    await handler(postRequest());
    release();
    await waitFor(() => !state.updating);

    const state2 = createTriggerState();
    let fail!: () => void;
    const performFail = mock(() => new Promise<UpdateResult>((resolve) => {
      fail = () => resolve({ success: false, error: 'pull failed', rolledBack: true });
    }));
    const handler2 = createTriggerHandler(createMockUpdater({ check, perform: performFail }), state2);
    await handler2(postRequest());
    fail();
    await waitFor(() => !state2.updating);
  });

  test('logs a crash and clears the busy flag when performUpdate rejects', async () => {
    const state = createTriggerState();
    let release!: () => void;
    const perform = mock(() => new Promise<UpdateResult>((_resolve, reject) => {
      release = () => reject(new Error('docker daemon gone'));
    }));
    const check = mock(() => Promise.resolve({ updateAvailable: true }));
    const handler = createTriggerHandler(createMockUpdater({ check, perform }), state);

    await handler(postRequest());
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
