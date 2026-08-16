import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEEDED_RULES, type RuleMatcher, type RuleState } from '@/lib/logs/rules';
import type { LogLane } from '@/lib/logs/types';

const MIGRATION_PATH = join(import.meta.dir, '..', '..', '..', '..', 'migrations', '037_log_detection.sql');
const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');

interface MigrationSeedRow {
  readonly matcher: RuleMatcher;
  readonly lane: LogLane;
  readonly state: RuleState;
  readonly operatorApproved: boolean;
  readonly hardSignal: boolean;
}

function extractSeedRow(id: string): MigrationSeedRow {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rowRe = new RegExp(
    `\\('${escapedId}', 1, '[^']*', '[^']*',\\n\\s*'((?:[^'\\\\]|\\\\.)*)',\\n\\s*'(\\w+)', '(\\w+)', (TRUE|FALSE), '\\{"kind":"fleet"\\}', (?:NULL|'\\{[\\d,]*\\}'),\\n\\s*\\d+, (TRUE|FALSE), (TRUE|FALSE),`,
  );
  const match = rowRe.exec(migrationSql);
  if (!match) {
    throw new Error(`migration row for ${id} not found or does not match the expected shape`);
  }
  const [, matcherJson, lane, state, , hardSignalStr, operatorApprovedStr] = match;
  return {
    matcher: JSON.parse(matcherJson) as RuleMatcher,
    lane: lane as LogLane,
    state: state as RuleState,
    hardSignal: hardSignalStr === 'TRUE',
    operatorApproved: operatorApprovedStr === 'TRUE',
  };
}

describe('SEEDED_RULES matches what migration 037 actually seeds', () => {
  test.each(SEEDED_RULES.map((rule) => [rule.id, rule] as const))('%s', (id, rule) => {
    const migrationRow = extractSeedRow(id);
    expect(rule.matcher).toEqual(migrationRow.matcher);
    expect(rule.lane).toBe(migrationRow.lane);
    expect(rule.state).toBe(migrationRow.state);
    expect(rule.hardSignal).toBe(migrationRow.hardSignal);
    expect(rule.operatorApproved).toBe(migrationRow.operatorApproved);
  });
});
