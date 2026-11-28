import { test } from 'bun:test';

test('never settles', () => new Promise<void>(() => {}));
