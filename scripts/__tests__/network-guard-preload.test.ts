import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const fixtures = join(import.meta.dir, 'fixtures');

async function runFixture(cwd: string, fixture: string) {
  const proc = Bun.spawn([process.execPath, 'test', '--isolate', join(fixtures, fixture)], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, output: stdout + stderr };
}

// Each child is a fresh bun process with the package's preloads, which needs startup headroom on a loaded runner.
const CHILD_TIMEOUT = 20_000;

describe('unit test network guard', () => {
  test.concurrent.each([
    ['homelab-manager', root],
    ['agent', join(root, 'agent')],
  ])(
    'blocks non-loopback calls in %s',
    async (_name, cwd) => {
      const { code, output } = await runFixture(cwd, 'network-escape.ts');

      expect(output).toContain('node:dns/promises lookup tried to reach "guard-probe.invalid"');
      expect(output).toContain('fetch tried to reach "guard-probe.invalid"');
      expect(output).toContain('WebSocket tried to reach "guard-probe.invalid"');
      expect(output).toContain('(fail) caught lookup');
      expect(output).toContain(
        'since the previous check, even if the code under test caught the error:\nUnit tests cannot use the network: node:dns/promises lookup tried to reach "caught.guard-probe.invalid"',
      );
      expect(output).toContain(
        'after the last check, even if the code under test caught the error:\nUnit tests cannot use the network: node:dns/promises lookup tried to reach "after-all.guard-probe.invalid"',
      );
      expect(output).toMatch(/^ 0 pass$/m);
      expect(code).not.toBe(0);
    },
    CHILD_TIMEOUT,
  );

  test(
    'lets native fetch reach loopback and unix sockets in agent',
    async () => {
      const { code, output } = await runFixture(join(root, 'agent'), 'network-escape-native.ts');

      expect(output).toMatch(/^ 2 pass$/m);
      expect(code).toBe(0);
    },
    CHILD_TIMEOUT,
  );
});
