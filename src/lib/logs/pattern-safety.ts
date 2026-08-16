import { check } from 'recheck';
import { checkPatternPolicy } from '@/lib/logs/rules';

/**
 * Analysis budget per pattern. Admission is interactive but rare, so a second of
 * analysis is affordable where a false negative is not.
 */
export const PATTERN_ANALYSIS_TIMEOUT_MS = 1_000;

export type PatternRejection =
  | 'pattern-too-long'
  | 'backreference'
  | 'unbounded-repeat'
  | 'invalid-regex'
  | 'catastrophic-backtracking'
  | 'analysis-inconclusive';

export interface PatternSafetyResult {
  readonly ok: boolean;
  readonly reason: PatternRejection | null;
  readonly detail: string | null;
}

const SAFE: PatternSafetyResult = { ok: true, reason: null, detail: null };

/**
 * Decides whether a rule pattern may be admitted. A detector pattern runs against
 * every line of every container, so an admitted pattern that backtracks
 * catastrophically stalls the whole worker, not one rule.
 *
 * Fails closed: anything other than a proof of safety is a rejection, because an
 * inconclusive analysis and a vulnerable pattern have the same blast radius.
 */
export type PatternChecker = (
  source: string,
  flags: string,
  options: { timeout: number },
) => Promise<Awaited<ReturnType<typeof check>>>;

export async function checkPatternSafety(
  pattern: string,
  checker: PatternChecker = check,
): Promise<PatternSafetyResult> {
  const policy = checkPatternPolicy(pattern);
  if (!policy.ok) {
    return { ok: false, reason: policy.reason as PatternRejection, detail: null };
  }

  let diagnostics: Awaited<ReturnType<typeof check>>;
  try {
    diagnostics = await checker(pattern, '', { timeout: PATTERN_ANALYSIS_TIMEOUT_MS });
  } catch (error) {
    return {
      ok: false,
      reason: 'analysis-inconclusive',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (diagnostics.status === 'safe') return SAFE;

  if (diagnostics.status === 'vulnerable') {
    return {
      ok: false,
      reason: 'catastrophic-backtracking',
      detail: `${diagnostics.complexity?.type ?? 'unknown'} complexity`,
    };
  }

  return {
    ok: false,
    reason: 'analysis-inconclusive',
    detail: diagnostics.error?.kind ?? 'unknown',
  };
}

export async function assertPatternSafety(
  pattern: string,
  checker?: PatternChecker,
): Promise<void> {
  const result = await checkPatternSafety(pattern, checker);
  if (!result.ok) {
    throw new Error(
      `rejected regex pattern: ${result.reason}${result.detail ? ` (${result.detail})` : ''}`,
    );
  }
}
