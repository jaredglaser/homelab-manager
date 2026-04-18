import { describe, expect, test, mock, beforeAll, afterAll } from 'bun:test';
import { sendSSE } from '../sse-utils';

const originalConsoleError = console.error;

beforeAll(() => {
  console.error = mock(() => {});
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
});
