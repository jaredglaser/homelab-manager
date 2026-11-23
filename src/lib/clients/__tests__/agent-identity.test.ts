import { describe, it, expect, spyOn } from 'bun:test';
import { Glob } from 'bun';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_IDENTITY_HEADER } from '@homelab-manager/agent/types';
import { notAnsweringLogLine, readNotAnsweringFailure } from '../agent-identity';

describe('readNotAnsweringFailure', () => {
  it('returns null for a response that carries the header, and leaves its body unread', async () => {
    const response = new Response('{"error":"x"}', { status: 500, headers: { [AGENT_IDENTITY_HEADER]: '0.4.0' } });

    expect(await readNotAnsweringFailure(response)).toBeNull();
    expect(response.bodyUsed).toBe(false);
  });

  it.each(['X-Homelab-Agent', 'x-homelab-agent', 'X-HOMELAB-AGENT'])('finds the header written as %s', async (name) => {
    expect(await readNotAnsweringFailure(new Response('x', { status: 500, headers: { [name]: 'v' } }))).toBeNull();
  });

  it('accepts any value, including an empty one, because only its presence counts', async () => {
    expect(await readNotAnsweringFailure(new Response('x', { status: 500, headers: { [AGENT_IDENTITY_HEADER]: '' } }))).toBeNull();
  });

  it('describes a response without it by status, copy and a bounded excerpt of its body', async () => {
    const failure = await readNotAnsweringFailure(new Response(`<html>\n${'a'.repeat(500)}`, { status: 502 }));

    expect(failure).toEqual({
      code: 'agent_not_answering',
      status: 502,
      detail: 'HTTP 502',
      message:
        'Something other than the agent answered (HTTP 502). Check that the agent URL points at the agent and that any proxy in front of it is running, then try again.',
      bodyExcerpt: `<html> ${'a'.repeat(293)}...`,
    });
  });

  it('gives an empty excerpt for a body-less response', async () => {
    expect((await readNotAnsweringFailure(new Response(null, { status: 504 })))?.bodyExcerpt).toBe('');
  });

  it('stops waiting on a body held open after the status line, keeping what arrived', async () => {
    const held = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('<html>'));
      },
    });
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const failure = await readNotAnsweringFailure(new Response(held, { status: 502 }), 20);

      expect(failure).toMatchObject({ code: 'agent_not_answering', status: 502, bodyExcerpt: '<html>', bodyReadFailure: 'timeout' });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('notAnsweringLogLine', () => {
  const base = { code: 'agent_not_answering', status: 502, detail: 'HTTP 502', message: 'm', bodyExcerpt: '<html>' } as const;

  it('puts the status and the excerpt after where it happened', () => {
    expect(notAnsweringLogLine(base, 'the update request for tower')).toBe('Something other than the agent answered the update request for tower: HTTP 502: <html>');
  });

  it('says when the excerpt is incomplete', () => {
    expect(notAnsweringLogLine({ ...base, bodyReadFailure: 'timeout' }, 'x')).toBe('Something other than the agent answered x: HTTP 502 (body read timed out): <html>');
    expect(notAnsweringLogLine({ ...base, bodyReadFailure: 'error' }, 'x')).toBe('Something other than the agent answered x: HTTP 502 (body read failed): <html>');
  });
});

describe('the identity header reader', () => {
  const repoRoot = join(import.meta.dir, '../../../..');

  it('is the only place in the manager that reads the header', () => {
    const readers: string[] = [];
    let scanned = 0;
    for (const path of new Glob('{src,server}/**/*.{ts,tsx}').scanSync({ cwd: repoRoot })) {
      if (path.includes('__tests__') || path.startsWith('src/lib/test/')) continue;
      scanned += 1;
      if (path === 'src/lib/clients/agent-identity.ts') continue;
      if (/AGENT_IDENTITY_HEADER|x-homelab-agent/i.test(readFileSync(join(repoRoot, path), 'utf8'))) readers.push(path);
    }
    expect(scanned).toBeGreaterThan(100);
    expect(readers).toEqual([]);
  });
});
