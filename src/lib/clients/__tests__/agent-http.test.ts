import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import { agentFetch, type AgentTlsContext } from '../agent-http';

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
      'No pinned TLS certificate for this HTTPS agent URL: run TLS enrollment for the host, then retry',
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

type RequestInitWithTls = RequestInit & { tls?: { ca: string; rejectUnauthorized: boolean } };
