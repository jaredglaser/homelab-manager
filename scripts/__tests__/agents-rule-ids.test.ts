import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const SECTIONS = ['Critical Rules', 'Gotchas'];
const ITEM = /^- \*\*.+?\*\* \(`([a-z0-9-]+)`\): /;
const CITATION = /AGENTS\.md#([a-z0-9-]+)/g;
const NUMBERED_CITATION = /\b(?:rule|gotcha)s?\s+#?\d+\b/i;
const SCANNED = /\.(?:ts|tsx|js|mjs|md|ya?ml|sh)$/;

const agentsLines = readFileSync(join(root, 'AGENTS.md'), 'utf-8').split('\n');

function topLevelItems(section: string): string[] {
  const start = agentsLines.indexOf(`## ${section}`);
  if (start === -1) return [];
  const rest = agentsLines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).filter((line) => /^(?:- |\d+\. )/.test(line));
}

const items = SECTIONS.flatMap(topLevelItems);
const ids = items.flatMap((line) => ITEM.exec(line)?.[1] ?? []);

const tracked = Bun.spawnSync(['git', 'ls-files'], { cwd: root })
  .stdout.toString()
  .split('\n')
  .filter((path) => SCANNED.test(path));

describe('AGENTS.md rule IDs', () => {
  test('both lists and the tracked files are found', () => {
    for (const section of SECTIONS) expect(topLevelItems(section)).not.toEqual([]);
    expect(tracked).toContain('AGENTS.md');
  });

  test('every rule and gotcha is a bullet with an ID', () => {
    expect(items.filter((line) => !ITEM.test(line))).toEqual([]);
  });

  test('no ID is used twice', () => {
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });

  test('AGENTS.md cites nothing by number', () => {
    expect(agentsLines.filter((line) => NUMBERED_CITATION.test(line))).toEqual([]);
  });

  test('every citation in the repo names an ID that exists', () => {
    const unknown = tracked.flatMap((path) =>
      [...readFileSync(join(root, path), 'utf-8').matchAll(CITATION)]
        .filter((match) => !ids.includes(match[1]))
        .map((match) => `${path} ${match[0]}`),
    );
    expect(unknown).toEqual([]);
  });
});
