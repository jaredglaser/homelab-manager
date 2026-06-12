import { describe, expect, test, mock, beforeAll, beforeEach, afterAll } from 'bun:test';
import { sendSSE, startSseHeartbeat } from '../sse-utils';

const originalConsoleError = console.error;

beforeAll(() => {
  console.error = mock(() => {});
});

beforeEach(() => {
  (console.error as ReturnType<typeof mock>).mockClear();
});

afterAll(() => {
  console.error = originalConsoleError;
});

function makeEncoder(): TextEncoder {
  return new TextEncoder();
}

function makeController(): {
  controller: ReadableStreamDefaultController<Uint8Array>;
  enqueued: string[];
  makeEnqueueThrow: (err: unknown) => void;
} {
  const enqueued: string[] = [];
  const decoder = new TextDecoder();
  let thrower: (() => never) | null = null;
  const controller = {
    enqueue: (chunk: Uint8Array) => {
      if (thrower) thrower();
      enqueued.push(decoder.decode(chunk));
    },
    close: () => {},
    error: () => {},
    desiredSize: 1,
  } as unknown as ReadableStreamDefaultController<Uint8Array>;

  return {
    controller,
    enqueued,
    makeEnqueueThrow: (err) => {
      thrower = () => {
        throw err;
      };
    },
  };
}

describe('sendSSE', () => {
  test('enqueues data: frame when not closed', () => {
    const { controller, enqueued } = makeController();
    sendSSE(controller, makeEncoder(), { value: false }, 'hello');
    expect(enqueued).toEqual(['data: hello\n\n']);
  });

  test('does nothing when closed flag is true', () => {
    const { controller, enqueued } = makeController();
    sendSSE(controller, makeEncoder(), { value: true }, 'hello');
    expect(enqueued).toHaveLength(0);
  });

  test('swallows TypeError from enqueue (enqueue-after-close)', () => {
    const { controller, makeEnqueueThrow } = makeController();
    makeEnqueueThrow(new TypeError('Controller is closed'));
    expect(() => {
      sendSSE(controller, makeEncoder(), { value: false }, 'hello');
    }).not.toThrow();
    expect(console.error).not.toHaveBeenCalledWith(
      'Unexpected error during SSE enqueue:',
      expect.anything(),
    );
  });

  test('sets closed.value to true when enqueue fails with close-matching TypeError', () => {
    const { controller, makeEnqueueThrow } = makeController();
    makeEnqueueThrow(new TypeError('Controller is closed'));
    const closed = { value: false };
    sendSSE(controller, makeEncoder(), closed, 'hello');
    expect(closed.value).toBe(true);
  });

  test('logs unexpected non-TypeError errors', () => {
    const { controller, makeEnqueueThrow } = makeController();
    const err = new Error('something weird');
    makeEnqueueThrow(err);
    sendSSE(controller, makeEncoder(), { value: false }, 'hello');
    expect(console.error).toHaveBeenCalledWith(
      'Unexpected error during SSE enqueue:',
      err,
    );
  });

  test('propagates non-close TypeError (genuine bug)', () => {
    const { controller, makeEnqueueThrow } = makeController();
    const err = new TypeError('argument must be a string');
    makeEnqueueThrow(err);
    expect(() => {
      sendSSE(controller, makeEncoder(), { value: false }, 'hello');
    }).toThrow(err);
  });
});

describe('startSseHeartbeat', () => {
  test('enqueues comment pings on each interval tick', async () => {
    const { controller, enqueued } = makeController();
    const stop = startSseHeartbeat(controller, makeEncoder(), () => false, 5);

    await new Promise((r) => setTimeout(r, 20));
    stop();

    expect(enqueued.length).toBeGreaterThanOrEqual(1);
    expect(enqueued[0]).toBe(': ping\n\n');
  });

  test('stops pinging once isClosed reports true', async () => {
    const { controller, enqueued } = makeController();
    let closed = false;
    const stop = startSseHeartbeat(controller, makeEncoder(), () => closed, 5);

    await new Promise((r) => setTimeout(r, 15));
    closed = true;
    await new Promise((r) => setTimeout(r, 15));
    const countAtClose = enqueued.length;
    await new Promise((r) => setTimeout(r, 15));
    stop();

    expect(enqueued.length).toBe(countAtClose);
  });

  test('clears itself when enqueue throws (controller already closed)', async () => {
    const { controller, enqueued, makeEnqueueThrow } = makeController();
    makeEnqueueThrow(new TypeError('Controller is closed'));
    const stop = startSseHeartbeat(controller, makeEncoder(), () => false, 5);

    await new Promise((r) => setTimeout(r, 30));
    stop();

    expect(enqueued).toHaveLength(0);
  });

  test('stop function prevents any further pings', async () => {
    const { controller, enqueued } = makeController();
    const stop = startSseHeartbeat(controller, makeEncoder(), () => false, 5);
    stop();

    await new Promise((r) => setTimeout(r, 20));

    expect(enqueued).toHaveLength(0);
  });
});
