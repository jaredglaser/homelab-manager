import type { DeployAction, DeployStatus, DeployTrigger } from '@/lib/deploy/types';
import type { ToastSeverity } from '@/hooks/toastAtom';

export interface DeployOutcomeEvent {
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

/** Takes the first line, strips control characters, and truncates to 200 chars without splitting a UTF-16 surrogate pair. */
export function truncateDeployMessage(message: string): string {
  const firstLine = message.split(/\r\n?|\n/)[0] ?? '';
  const stripped = Array.from(firstLine)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join('');
  if (stripped.length <= MAX_MESSAGE_LENGTH) return stripped;
  let end = MAX_MESSAGE_LENGTH;
  const boundary = stripped.charCodeAt(end - 1);
  if (boundary >= 0xd800 && boundary <= 0xdbff) end -= 1;
  return stripped.slice(0, end);
}

function deployNoun(action: DeployAction, trigger: DeployTrigger): string {
  if (action === 'teardown') return 'Teardown';
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
 */
export function formatDeployOutcome(evt: DeployOutcomeEvent): DeployOutcomeToast | null {
  if (evt.status === 'pending' || evt.status === 'in_progress') return null;

  if (evt.status === 'no_change') {
    if (evt.trigger !== 'ui') return null;
    return { message: `No changes detected for ${evt.stack}`, severity: 'info' };
  }

  const base = `${deployNoun(evt.action, evt.trigger)} of ${evt.stack}${deploySuffix(evt.action, evt.trigger)}`;

  if (evt.status === 'succeeded') {
    return { message: `${base} succeeded`, severity: 'success' };
  }

  const detail = evt.message ? `: ${truncateDeployMessage(evt.message)}` : '';
  return { message: `${base} failed${detail}`, severity: 'error' };
}

export interface DeployToastGate {
  /** Atomic test-and-set: true (and marks seen) the first time a deployId is passed, false on every later call. */
  shouldToast(deployId: number): boolean;
  /** Alias for shouldToast, used at mutation onMutate time to pre-claim a deployId before the SSE outcome can arrive. */
  claim(deployId: number): boolean;
  /** Undo a claim so a later SSE outcome can still toast; used when the mutation that pre-claimed fails client-side. */
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
