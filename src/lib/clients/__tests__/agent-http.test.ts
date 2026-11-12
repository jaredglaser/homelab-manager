import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import { agentFetch, isMissingPinError, openAgentWebSocket, toPlainHttpUrl, type AgentTlsContext } from '../agent-http';

const PROBE_PATH = join(import.meta.dir, '../../test/agent-http-loopback-probe.ts');

describe('agentFetch', () => {
  it('pins the fixture cert against a live loopback TLS agent and rejects mismatches', async () => {
    const proc = Bun.spawn([process.execPath, PROBE_PATH], { stdout: 'pipe', stderr: 'pipe' });
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (exitCode !== 0) throw new Error(`loopback probe failed: ${stderr}`);
    expect(exitCode).toBe(0);
  });

  it('passes the pinned cert as the fetch tls option', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response('{}'));
    };
    const tls: AgentTlsContext = { caCertPem: 'PINNED' };
    await agentFetch('https://agent:9090/info', {}, tls, fakeFetch);
    expect(calls).toHaveLength(1);
    expect((calls[0].init as RequestInitWithTls).tls).toEqual({ ca: 'PINNED', rejectUnauthorized: true });
  });

  it('omits the tls option on the injected fetch for http urls', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response('{}'));
    };
    await agentFetch('http://agent:9090/info', {}, { caCertPem: 'PINNED' }, fakeFetch);
    expect((calls[0].init as RequestInitWithTls).tls).toBeUndefined();
  });

  it('refuses to connect to an https url without a pinned cert', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response('{}'));
    };
    await expect(agentFetch('https://agent:9090/info', {}, { caCertPem: null }, fakeFetch)).rejects.toThrow(
      'No pinned TLS certificate for this HTTPS agent URL, so the manager cannot verify the agent. '
      + 'See the agent TLS recovery steps in the self-hosting guide.',
    );
    expect(calls).toHaveLength(0);
  });

  it('treats a whitespace-only cert like an absent one on https', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response('{}'));
    };
    await expect(agentFetch('https://agent:9090/info', {}, { caCertPem: '   ' }, fakeFetch)).rejects.toThrow(
      'No pinned TLS certificate for this HTTPS agent URL',
    );
    expect(calls).toHaveLength(0);
  });

  it('treats an unparseable url as non-https', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response('{}'));
    };
    await agentFetch('not a url', {}, { caCertPem: 'PINNED' }, fakeFetch);
    expect((calls[0].init as RequestInitWithTls).tls).toBeUndefined();
  });
});

describe('openAgentWebSocket', () => {
  it('refuses a wss url without a pinned cert', () => {
    expect(() => openAgentWebSocket('wss://agent:9090/exec/x', {}, { caCertPem: null })).toThrow(
      'No pinned TLS certificate for this HTTPS agent URL, so the manager cannot verify the agent. '
      + 'See the agent TLS recovery steps in the self-hosting guide.',
    );
  });

  it('treats a whitespace-only cert like an absent one on wss', () => {
    expect(() => openAgentWebSocket('wss://agent:9090/exec/x', {}, { caCertPem: '   ' })).toThrow(
      'No pinned TLS certificate for this HTTPS agent URL',
    );
  });

  it('does not require a pinned cert on ws urls', () => {
    // Pins the invariant asymmetry with the wss refusal tests above: ws agent
    // URLs skip the cert requirement. The constructor is stubbed because
    // happy-dom's real one would dial ws:// and fire unhandled error events;
    // the Bun-specific header/tls arg shape is verified by the loopback probe,
    // not here.
    const original = globalThis.WebSocket;
    class WsStub {
      constructor(..._args: unknown[]) {}
    }
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = WsStub;
    try {
      expect(() =>
        openAgentWebSocket('ws://agent:9090/exec/x', { headers: { Authorization: 'Bearer t' } }, { caCertPem: null }),
      ).not.toThrow();
      expect(() => openAgentWebSocket('ws://agent:9090/exec/x', {}, { caCertPem: null })).not.toThrow();
    } finally {
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = original;
    }
  });
});

type RequestInitWithTls = RequestInit & { tls?: { ca: string; rejectUnauthorized: boolean } };

describe('toPlainHttpUrl', () => {
  it('swaps the scheme and keeps the host, port and IPv6 brackets', () => {
    expect(toPlainHttpUrl(new URL('https://myhost.lan:9090/'))).toBe('http://myhost.lan:9090');
    expect(toPlainHttpUrl(new URL('https://[::1]:9090'))).toBe('http://[::1]:9090');
  });
});

describe('isMissingPinError', () => {
  it('recognizes the seam refusal and nothing else', () => {
    expect(isMissingPinError(new Error('No pinned TLS certificate for this HTTPS agent URL'))).toBe(true);
    expect(isMissingPinError(new Error('ECONNREFUSED'))).toBe(false);
    expect(isMissingPinError('No pinned TLS certificate')).toBe(false);
  });
});
