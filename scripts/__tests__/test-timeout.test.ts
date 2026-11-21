import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const fixture = join(import.meta.dir, 'fixtures', 'never-settles.ts');

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

describe('per-test timeout', () => {
  // Bun ignores `timeout` in bunfig.toml, so the limit only holds while each package's preload sets it.
  test.concurrent.each([
    ['homelab-manager', root],
    ['agent', join(root, 'agent')],
  ])(
    'fails a test that outlives the limit in %s',
    async (_name, cwd) => {
      const { code, output } = await runFixture(cwd);

      expect(output).toContain('this test timed out after 2000ms');
      expect(code).not.toBe(0);
    },
    // The child waits out the full 2000ms, then needs bun startup headroom on a loaded runner.
    20_000,
  );
});
