import { afterAll, test } from 'bun:test';
import { lookup } from 'node:dns/promises';

const HOST = 'guard-probe.invalid';

test('dns lookup', () => lookup(HOST));

test('fetch', () => fetch(`http://${HOST}/`));

test('WebSocket', () => {
  new WebSocket(`ws://${HOST}/`).close();
});

test('caught lookup', () => lookup(`caught.${HOST}`).catch(() => undefined));

afterAll(() => lookup(`after-all.${HOST}`).catch(() => undefined));
