import { expect, test } from 'bun:test';
import { lookup } from 'node:dns/promises';

const HOST = 'guard-probe.invalid';

test('dns lookup', () => lookup(HOST));

test('fetch', () => fetch(`http://${HOST}/`));

test('WebSocket', () => {
  new WebSocket(`ws://${HOST}/`).close();
});

test.skipIf(typeof window !== 'undefined')('native fetch reaches Bun.serve on 127.0.0.1', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('loopback') });
  try {
    expect(await (await fetch(server.url)).text()).toBe('loopback');
  } finally {
    await server.stop(true);
  }
});
