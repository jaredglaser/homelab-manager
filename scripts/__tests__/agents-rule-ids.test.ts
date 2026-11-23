import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const SECTIONS = ['Critical Rules', 'Gotchas'];
const ITEM = /^- \*\*.+?\*\* \(`([a-z0-9-]+)`\): /;
const CITATION = /AGENTS\.md#([a-z0-9-]+)/g;
const NUMBERED_CITATION = /\b(?:rule|gotcha)s?\s+#?\d+\b/i;
const SCANNED = /\.(?:ts|tsx|js|mjs|md|ya?ml|sh)$/;
// The changelog quotes old commit subjects, which may cite a rule by its former number.
const UNSCANNED = new Set(['CHANGELOG.md']);

function sectionLines(name: string): string[] {
  const lines = readFileSync(join(root, 'AGENTS.md'), 'utf-8').split('\n');
  const start = lines.indexOf(`## ${name}`);
  const length = lines.slice(start + 1).findIndex((line) => line.startsWith('## '));
  return lines.slice(start + 1, start + 1 + length);
}

const topLevelItems = SECTIONS.flatMap(sectionLines).filter((line) => /^(?:- |\d+\. )/.test(line));
const ids = topLevelItems.flatMap((line) => ITEM.exec(line)?.[1] ?? []);

const tracked = Bun.spawnSync(['git', 'ls-files'], { cwd: root })
  .stdout.toString()
  .split('\n')
  .filter((path) => SCANNED.test(path) && !UNSCANNED.has(path));
const scannedLines = tracked.flatMap((path) =>
  readFileSync(join(root, path), 'utf-8')
    .split('\n')
    .map((text, index) => ({ where: `${path}:${index + 1}`, text })),
);

describe('AGENTS.md rule IDs', () => {
  test('discovery finds the rules, the tracked files, and at least one citation', () => {
    expect(ids.length).toBeGreaterThanOrEqual(40);
    expect(tracked.length).toBeGreaterThan(100);
    expect(scannedLines.some(({ text }) => text.search(CITATION) !== -1)).toBe(true);
  });

  test('every rule and gotcha is a bullet with an ID', () => {
    expect(topLevelItems.filter((line) => !ITEM.test(line))).toEqual([]);
  });

  test('no ID is used twice', () => {
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });

  test('every citation names an ID that exists', () => {
    const unknown = scannedLines.flatMap(({ where, text }) =>
      [...text.matchAll(CITATION)].filter((match) => !ids.includes(match[1])).map((match) => `${where} ${match[0]}`),
    );
    expect(unknown).toEqual([]);
  });

  test('nothing cites a rule or gotcha by number', () => {
    expect(scannedLines.filter(({ text }) => NUMBERED_CITATION.test(text)).map(({ where }) => where)).toEqual([]);
  });
});
