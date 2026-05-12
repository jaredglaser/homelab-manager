import { describe, expect, test, mock, beforeAll, afterAll, type Mock } from 'bun:test';
import { HealthReporter } from '../health-reporter';

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;

beforeAll(() => {
  console.error = mock(() => {});
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
});

function mockFetch(impl: () => Promise<Response | never>): Mock<typeof fetch> {
  const fn = mock(impl) as unknown as Mock<typeof fetch>;
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('HealthReporter', () => {
  test('returns true when agent responds 200', async () => {
    const fetchMock = mockFetch(() => Promise.resolve(new Response('OK', { status: 200 })));

    const reporter = new HealthReporter('http://localhost:9090');
    const result = await reporter.checkAgentHealth();

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('returns false when agent responds non-200', async () => {
    mockFetch(() => Promise.resolve(new Response('Service Unavailable', { status: 503 })));

    const reporter = new HealthReporter('http://localhost:9090');
    const result = await reporter.checkAgentHealth();

    expect(result).toBe(false);
  });

  test('returns false when agent is unreachable', async () => {
    mockFetch(() => Promise.reject(new Error('Connection refused')));

    const reporter = new HealthReporter('http://localhost:9090');
    const result = await reporter.checkAgentHealth();

    expect(result).toBe(false);
  });

  test('uses custom timeout with AbortSignal', async () => {
    let capturedSignal: AbortSignal | undefined;
    const fn = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return Promise.resolve(new Response('OK', { status: 200 }));
    }) as unknown as Mock<typeof fetch>;
    globalThis.fetch = fn as unknown as typeof fetch;

    const reporter = new HealthReporter('http://localhost:9090');
    const result = await reporter.checkAgentHealth(1000);

    expect(result).toBe(true);
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });

  test('returns false when request times out', async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        }
      });
    }) as typeof fetch;

    const reporter = new HealthReporter('http://localhost:9090');
    const result = await reporter.checkAgentHealth(50);

    expect(result).toBe(false);
  });

  test('calls correct health endpoint URL', async () => {
    const fetchMock = mockFetch(() => Promise.resolve(new Response('OK', { status: 200 })));

    const reporter = new HealthReporter('http://agent.local:8080');
    await reporter.checkAgentHealth();

    expect(fetchMock.mock.calls[0][0]).toBe('http://agent.local:8080/health');
  });

  test('returns false when agent URL returns a redirect (3xx)', async () => {
    mockFetch(() =>
      Promise.resolve(new Response(null, { status: 301, headers: { Location: 'http://169.254.169.254/metadata' } }))
    );

    const reporter = new HealthReporter('http://localhost:9090');
    const result = await reporter.checkAgentHealth();

    expect(result).toBe(false);
  });

  test('passes redirect: manual to fetch', async () => {
    let capturedInit: RequestInit | undefined;
    const fn = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(new Response('OK', { status: 200 }));
    }) as unknown as Mock<typeof fetch>;
    globalThis.fetch = fn as unknown as typeof fetch;

    const reporter = new HealthReporter('http://localhost:9090');
    await reporter.checkAgentHealth();

    expect(capturedInit?.redirect).toBe('manual');
  });
});
