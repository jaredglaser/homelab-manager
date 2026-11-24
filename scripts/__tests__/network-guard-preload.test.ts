import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const fixture = join(import.meta.dir, 'fixtures', 'network-escape.ts');

async function runFixture(cwd: string) {
  const proc = Bun.spawn([process.execPath, 'test', '--isolate', fixture], {
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

describe('unit test network guard', () => {
  test.concurrent.each([
    ['homelab-manager', root, 0],
    ['agent', join(root, 'agent'), 2],
  ])(
    'blocks non-loopback calls in %s',
    async (_name, cwd, loopbackPasses) => {
      const { code, output } = await runFixture(cwd);

      expect(output).toContain('node:dns/promises lookup tried to reach "guard-probe.invalid"');
      expect(output).toContain('fetch tried to reach "guard-probe.invalid"');
      expect(output).toContain('WebSocket tried to reach "guard-probe.invalid"');
      expect(output).toContain('(fail) caught lookup');
      expect(output).toContain(
        'since the previous test ended, even if the code under test caught the error:\nUnit tests cannot use the network: node:dns/promises lookup tried to reach "caught.guard-probe.invalid"',
      );
      expect(output).toContain(
        'since the last test ended, even if the code under test caught the error:\nUnit tests cannot use the network: node:dns/promises lookup tried to reach "after-all.guard-probe.invalid"',
      );
      expect(output).toMatch(new RegExp(`^ ${loopbackPasses} pass$`, 'm'));
      expect(code).not.toBe(0);
    },
    // Each child is a fresh bun process with the package's preloads, which needs startup headroom on a loaded runner.
    20_000,
  );
});
