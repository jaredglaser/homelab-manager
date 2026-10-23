import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const PACKAGE_DIRS = ['.', 'agent', 'agent-updater'];

const expected = readFileSync(join(root, '.bun-version'), 'utf-8').trim();

const dockerfiles = PACKAGE_DIRS.flatMap((dir) =>
  readdirSync(join(root, dir))
    .filter((name) => /^Dockerfile/.test(name))
    .map((name) => join(dir, name)),
);
const packages = PACKAGE_DIRS.map((dir) => join(dir, 'package.json'));
const workflows = readdirSync(join(root, '.github', 'workflows'))
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => join('.github', 'workflows', name));

function read(path: string): string {
  return readFileSync(join(root, path), 'utf-8');
}

// Lines of a step's with-block: the `uses:` and `with:` keys sit at 8 spaces,
// their values at 10; the block ends at the next step (`- ` at 6) or any dedent.
function withBlock(lines: string[], usesIndex: number): string[] {
  const block: string[] = [];
  for (let i = usesIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (indent < 8) break;
    if (indent >= 10) block.push(line);
  }
  return block;
}

describe('bun version alignment', () => {
  test('.bun-version is a concrete x.y.z pin', () => {
    expect(expected).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('discovery finds every deployable Dockerfile, package, and workflow', () => {
    expect(dockerfiles.length).toBeGreaterThanOrEqual(3);
    expect(packages.length).toBeGreaterThanOrEqual(3);
    expect(workflows.length).toBeGreaterThanOrEqual(2);
  });

  test.each(dockerfiles)('%s ARG defaults match .bun-version', (path) => {
    const defaults = [...read(path).matchAll(/^ARG BUN_VERSION=(\S+)$/gm)].map((m) => m[1]);
    expect(defaults.length).toBeGreaterThan(0);
    for (const value of defaults) {
      expect(value).toBe(expected);
    }
  });

  test.each(dockerfiles)('%s FROM lines are templated on BUN_VERSION', (path) => {
    const fromLines = read(path)
      .split('\n')
      .filter((line) => line.startsWith('FROM oven/bun:'));
    expect(fromLines.length).toBeGreaterThan(0);
    for (const line of fromLines) {
      expect(line).toMatch(/^FROM oven\/bun:\$\{BUN_VERSION\}(-slim)?( AS \S+)?$/);
    }
  });

  test('cache mount ids carry no hardcoded version', () => {
    const hardcoded = dockerfiles
      .flatMap((path) =>
        read(path)
          .split('\n')
          .filter((line) => line.includes('id=bun-')),
      )
      .filter((line) => !line.includes('id=bun-${BUN_VERSION}') && !line.includes('id=bun-agent-${BUN_VERSION}'));
    expect(hardcoded).toEqual([]);
  });

  test.each(packages)('%s @types/bun matches .bun-version', (path) => {
    const pkg = JSON.parse(read(path)) as { devDependencies: Record<string, string> };
    expect(pkg.devDependencies['@types/bun']).toBe(expected);
  });

  test.each(workflows)('%s setup-bun steps read .bun-version', (path) => {
    const lines = read(path).split('\n');
    const unpinned = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.includes('uses: oven-sh/setup-bun'))
      .filter(({ index }) => !withBlock(lines, index).some((l) => l.includes('bun-version-file: .bun-version')));
    expect(unpinned).toEqual([]);
  });
});
