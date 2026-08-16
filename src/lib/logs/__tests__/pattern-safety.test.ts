import { describe, expect, test } from 'bun:test';
import { assertPatternSafety, checkPatternSafety } from '@/lib/logs/pattern-safety';

const ANALYSIS_TIMEOUT_MS = 15_000;

describe('checkPatternSafety', () => {
  test.each([
    ['(a+)+$', 'nested quantifier'],
    ['^(\\w+\\s?)*$', 'trailing-space alternation'],
    ['^([a-zA-Z0-9]+)*$', 'star of plus'],
    ['^(a*)*b', 'nested star'],
  ])('rejects %s (%s)', async (pattern) => {
    const result = await checkPatternSafety(pattern);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('catastrophic-backtracking');
  }, ANALYSIS_TIMEOUT_MS);

  test.each([
    ['\\b(ERROR|FATAL|PANIC)\\b', 'level tokens'],
    ['connection refused', 'literal'],
    ['^\\d{3}-\\d{4}$', 'bounded quantifiers'],
    ['OOMKilled', 'single token'],
  ])('admits %s (%s)', async (pattern) => {
    const result = await checkPatternSafety(pattern);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
  }, ANALYSIS_TIMEOUT_MS);

  test('rejects overlapping alternation branches that are not identical', async () => {
    const result = await checkPatternSafety('(a|ab)+$');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('catastrophic-backtracking');
    expect(result.detail).toContain('polynomial');
  }, ANALYSIS_TIMEOUT_MS);

  test('admits a quantified group whose interior cannot backtrack', async () => {
    const result = await checkPatternSafety('(.*,)*');
    expect(result.ok).toBe(true);
  }, ANALYSIS_TIMEOUT_MS);

  test('applies the syntactic policy before spending analysis budget', async () => {
    expect(await checkPatternSafety('(a)\\1')).toMatchObject({ ok: false, reason: 'backreference' });
    expect(await checkPatternSafety('a{2000}')).toMatchObject({ ok: false, reason: 'unbounded-repeat' });
    expect(await checkPatternSafety('(')).toMatchObject({ ok: false, reason: 'invalid-regex' });
    expect(await checkPatternSafety('x'.repeat(100_000))).toMatchObject({
      ok: false,
      reason: 'pattern-too-long',
    });
  });

  test('rejects named backreferences the same as numbered ones', async () => {
    const result = await checkPatternSafety('(?<name>a)b\\k<name>');
    expect(result).toMatchObject({ ok: false, reason: 'backreference' });
  });

  test('fails closed when the analysis times out rather than proving safety', async () => {
    const result = await checkPatternSafety('\\bOOMKilled\\b', async () => ({
      source: '', flags: '', status: 'unknown', error: { kind: 'timeout' },
    }) as never);
    expect(result).toMatchObject({ ok: false, reason: 'analysis-inconclusive', detail: 'timeout' });
  });

  test('fails closed when the analyser throws', async () => {
    const result = await checkPatternSafety('\\bOOMKilled\\b', async () => {
      throw new Error('worker died');
    });
    expect(result).toMatchObject({ ok: false, reason: 'analysis-inconclusive', detail: 'worker died' });
  });
});

describe('assertPatternSafety', () => {
  test('throws with the reason for a rejected pattern', async () => {
    await expect(assertPatternSafety('(a+)+$')).rejects.toThrow(/catastrophic-backtracking/);
  }, ANALYSIS_TIMEOUT_MS);

  test('resolves for an admissible pattern', async () => {
    await expect(assertPatternSafety('\\bOOMKilled\\b')).resolves.toBeUndefined();
  }, ANALYSIS_TIMEOUT_MS);
});
