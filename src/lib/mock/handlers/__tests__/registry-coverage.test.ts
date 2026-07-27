import { describe, it, expect } from 'bun:test';

import { registeredServerFnNames } from '@/lib/mock/handlers/server-functions';

const SRC_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_FN_EXPORT = /^export const ([A-Za-z0-9_$]+) = createServerFn/gm;

// node:fs is mocked by sibling suites and the mock leaks across files, so read
// through Bun's file APIs instead.
async function collectServerFnExports(): Promise<string[]> {
  const glob = new Bun.Glob('**/*.{ts,tsx}');
  const names: string[] = [];
  for await (const relative of glob.scan({ cwd: SRC_ROOT })) {
    if (relative.includes('__tests__/')) continue;
    const source = await Bun.file(SRC_ROOT + relative).text();
    for (const match of source.matchAll(SERVER_FN_EXPORT)) names.push(match[1]);
  }
  return [...new Set(names)].sort();
}

describe('server-function registry coverage', () => {
  it('registers a mock for every createServerFn export under src', async () => {
    const exported = await collectServerFnExports();
    expect(exported.length).toBeGreaterThan(20);

    const registered = new Set(registeredServerFnNames);
    expect(exported.filter((name) => !registered.has(name))).toEqual([]);
  });
});
