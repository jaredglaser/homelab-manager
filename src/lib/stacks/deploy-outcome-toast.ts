import type { DeployAction, DeployStatus, DeployTrigger } from '@/lib/deploy/types';
import type { StackDriftResolutionResult } from '@/types/stacks';
import type { ToastSeverity } from '@/hooks/toastAtom';

export interface DeployOutcomeEvent {
  host: string;
  stack: string;
  action: DeployAction;
  status: DeployStatus;
  trigger: DeployTrigger;
  message?: string | null;
}

export interface DeployOutcomeToast {
  message: string;
  severity: ToastSeverity;
}

const MAX_MESSAGE_LENGTH = 200;

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

function stripControlCharacters(line: string): string {
  return Array.from(line)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join('');
}

/**
 * Summarises a deploy message on one line of at most 200 chars. A failed run shows the last line that has text
 * once ANSI escapes and control characters are gone, keeping its end (daemon errors put the cause last) behind
 * "...". Any other outcome shows the first line, keeping its start. Neither cut splits a UTF-16 surrogate pair.
 */
export function truncateDeployMessage(message: string, status?: DeployStatus): string {
  const lines = message.split(/\r\n?|\n/);
  if (status !== 'failed') return headOf(stripControlCharacters(lines[0] ?? ''));
  const cleaned = lines.map((line) => stripControlCharacters(line.replace(ANSI_ESCAPE, '')));
  return tailOf(cleaned.filter((line) => line.trim() !== '').at(-1) ?? '');
}

function headOf(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  let end = MAX_MESSAGE_LENGTH;
  const boundary = text.charCodeAt(end - 1);
  if (boundary >= 0xd800 && boundary <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function tailOf(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  let start = text.length - (MAX_MESSAGE_LENGTH - 3);
  const boundary = text.charCodeAt(start);
  if (boundary >= 0xdc00 && boundary <= 0xdfff) start += 1;
  return `...${text.slice(start)}`;
}

function deployNoun(action: DeployAction, trigger: DeployTrigger): string {
  if (action === 'teardown') return 'Teardown';
  if (action === 'update') return 'Image update';
  if (trigger === 'manual_rollback') return 'Rollback';
  return 'Deploy';
}

function deploySuffix(action: DeployAction, trigger: DeployTrigger): string {
  return action === 'deploy' && trigger === 'git_push' ? ' (git push)' : '';
}

/**
 * Map a deploy outcome to toast copy. Returns null for non-terminal statuses
 * ('pending', 'in_progress') and for 'no_change' outside a UI-triggered
 * deploy (git-push/rollback no_change events are routine and would spam).
 * 'queued' does toast: a push that lands mid-deploy is otherwise silent.
 */
export function formatDeployOutcome(evt: DeployOutcomeEvent): DeployOutcomeToast | null {
  if (evt.status === 'pending' || evt.status === 'in_progress') return null;

  if (evt.status === 'queued') {
    return { message: `Deploy of ${evt.host}/${evt.stack}${deploySuffix(evt.action, evt.trigger)} queued behind an active deploy`, severity: 'info' };
  }

  if (evt.status === 'no_change') {
    if (evt.trigger !== 'ui') return null;
    return { message: `No changes detected for ${evt.host}/${evt.stack}`, severity: 'info' };
  }

  const base = `${deployNoun(evt.action, evt.trigger)} of ${evt.host}/${evt.stack}${deploySuffix(evt.action, evt.trigger)}`;

  if (evt.status === 'succeeded') {
    return { message: `${base} succeeded`, severity: 'success' };
  }

  const detail = evt.message ? `: ${truncateDeployMessage(evt.message, evt.status)}` : '';
  return { message: `${base} failed${detail}`, severity: 'error' };
}

/**
 * A resolution that ran a deploy reports that deploy's outcome, because the
 * deploy can fail after the destructive step has already overwritten or torn
 * down the host's copy.
 */
export function formatDriftResolutionOutcome(
  host: string,
  stack: string,
  result: Pick<StackDriftResolutionResult, 'recoveryCommitSha' | 'deployStatus'>,
): DeployOutcomeToast {
  const archived = result.recoveryCommitSha
    ? `. Host copy archived in ${result.recoveryCommitSha.slice(0, 7)}.`
    : '';

  if (!result.deployStatus) {
    return { message: `Resolved drift for ${host}/${stack}${archived}`, severity: 'success' };
  }

  const outcome = formatDeployOutcome({
    host,
    stack,
    action: 'deploy',
    status: result.deployStatus,
    trigger: 'ui',
  });
  if (!outcome) {
    return { message: `Drift resolution for ${host}/${stack} is still deploying${archived}`, severity: 'info' };
  }
  return { message: `${outcome.message}${archived}`, severity: outcome.severity };
}

export interface DeployToastGate {
  /** Atomic test-and-set: true (and marks seen) the first time a deployId is passed, false on every later call. */
  shouldToast(deployId: number): boolean;
  /** Alias for shouldToast, used at mutation onMutate time to pre-claim a deployId before the stream outcome can arrive. */
  claim(deployId: number): boolean;
  /** Undo a claim so a later stream outcome can still toast. Used when the mutation that pre-claimed fails client-side. */
  release(deployId: number): void;
}

/** Factory for tests; production code uses the singleton `deployToastGate` below. */
export function createDeployToastGate(): DeployToastGate {
  const seen = new Set<number>();
  function shouldToast(deployId: number): boolean {
    if (seen.has(deployId)) return false;
    seen.add(deployId);
    return true;
  }
  function release(deployId: number): void {
    seen.delete(deployId);
  }
  return { shouldToast, claim: shouldToast, release };
}

export const deployToastGate = createDeployToastGate();
