import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('native fetch reaches Bun.serve on 127.0.0.1', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('loopback') });
  try {
    expect(await (await fetch(server.url)).text()).toBe('loopback');
  } finally {
    await server.stop(true);
  }
});

test('native fetch with a unix socket ignores the URL host', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'network-escape-'));
  const unix = join(dir, 'guard.sock');
  const server = Bun.serve({ unix, fetch: () => new Response('unix') });
  try {
    expect(await (await fetch('http://guard-probe.invalid/', { unix })).text()).toBe('unix');
  } finally {
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
