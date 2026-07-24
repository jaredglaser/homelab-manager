import { describe, test, expect } from 'bun:test';
import {
  createDeployToastGate,
  formatDeployOutcome,
  truncateDeployMessage,
} from '@/lib/stacks/deploy-outcome-toast';

describe('formatDeployOutcome', () => {
  test('returns null for pending status', () => {
    expect(formatDeployOutcome({ stack: 'plex', action: 'deploy', status: 'pending', trigger: 'ui' })).toBeNull();
  });

  test('returns null for in_progress status', () => {
    expect(formatDeployOutcome({ stack: 'plex', action: 'deploy', status: 'in_progress', trigger: 'ui' })).toBeNull();
  });

  test('returns null for no_change with a git_push trigger', () => {
    expect(formatDeployOutcome({ stack: 'plex', action: 'deploy', status: 'no_change', trigger: 'git_push' })).toBeNull();
  });

  test('returns null for no_change with a manual_rollback trigger', () => {
    expect(formatDeployOutcome({ stack: 'plex', action: 'deploy', status: 'no_change', trigger: 'manual_rollback' })).toBeNull();
  });

  test('returns an info toast for no_change with a ui trigger', () => {
    expect(formatDeployOutcome({ stack: 'plex', action: 'deploy', status: 'no_change', trigger: 'ui' })).toEqual({
      message: 'No changes detected for plex',
      severity: 'info',
    });
  });

  test('formats a successful ui deploy', () => {
    expect(formatDeployOutcome({ stack: 'plex', action: 'deploy', status: 'succeeded', trigger: 'ui' })).toEqual({
      message: 'Deploy of plex succeeded',
      severity: 'success',
    });
  });

  test('formats a successful teardown', () => {
    expect(formatDeployOutcome({ stack: 'plex', action: 'teardown', status: 'succeeded', trigger: 'ui' })).toEqual({
      message: 'Teardown of plex succeeded',
      severity: 'success',
    });
  });

  test('formats a successful rollback', () => {
    expect(formatDeployOutcome({ stack: 'plex', action: 'deploy', status: 'succeeded', trigger: 'manual_rollback' })).toEqual({
      message: 'Rollback of plex succeeded',
      severity: 'success',
    });
  });

  test('formats a successful git-push deploy with the "(git push)" suffix', () => {
    expect(formatDeployOutcome({ stack: 'plex', action: 'deploy', status: 'succeeded', trigger: 'git_push' })).toEqual({
      message: 'Deploy of plex (git push) succeeded',
      severity: 'success',
    });
  });

  test('formats a failed ui deploy without a message', () => {
    expect(formatDeployOutcome({ stack: 'plex', action: 'deploy', status: 'failed', trigger: 'ui' })).toEqual({
      message: 'Deploy of plex failed',
      severity: 'error',
    });
  });

  test('formats a failed ui deploy with a message', () => {
    expect(formatDeployOutcome({
      stack: 'plex', action: 'deploy', status: 'failed', trigger: 'ui', message: 'image not found',
    })).toEqual({
      message: 'Deploy of plex failed: image not found',
      severity: 'error',
    });
  });

  test('formats a failed rollback with a message', () => {
    expect(formatDeployOutcome({
      stack: 'plex', action: 'deploy', status: 'failed', trigger: 'manual_rollback', message: 'agent unreachable',
    })).toEqual({
      message: 'Rollback of plex failed: agent unreachable',
      severity: 'error',
    });
  });

  test('formats a failed teardown with a message', () => {
    expect(formatDeployOutcome({
      stack: 'plex', action: 'teardown', status: 'failed', trigger: 'ui', message: 'compose down failed',
    })).toEqual({
      message: 'Teardown of plex failed: compose down failed',
      severity: 'error',
    });
  });

  test('formats a successful update', () => {
    expect(formatDeployOutcome({ stack: 'plex', action: 'update', status: 'succeeded', trigger: 'ui' })).toEqual({
      message: 'Image update of plex succeeded',
      severity: 'success',
    });
  });

  test('formats a failed update with a message', () => {
    expect(formatDeployOutcome({
      stack: 'plex', action: 'update', status: 'failed', trigger: 'ui', message: 'pull failed: image not found',
    })).toEqual({
      message: 'Image update of plex failed: pull failed: image not found',
      severity: 'error',
    });
  });

  test('formats a failed update without a message', () => {
    expect(formatDeployOutcome({ stack: 'plex', action: 'update', status: 'failed', trigger: 'ui' })).toEqual({
      message: 'Image update of plex failed',
      severity: 'error',
    });
  });

  test('formats a failed git-push deploy with the "(git push)" suffix and a message', () => {
    expect(formatDeployOutcome({
      stack: 'plex', action: 'deploy', status: 'failed', trigger: 'git_push', message: 'image not found',
    })).toEqual({
      message: 'Deploy of plex (git push) failed: image not found',
      severity: 'error',
    });
  });

  test('treats a null message the same as no message', () => {
    expect(formatDeployOutcome({
      stack: 'plex', action: 'deploy', status: 'failed', trigger: 'ui', message: null,
    })).toEqual({
      message: 'Deploy of plex failed',
      severity: 'error',
    });
  });

  test('truncates the message to the first line and 200 chars', () => {
    const raw = 'x'.repeat(250) + '\nsecond line';
    const result = formatDeployOutcome({ stack: 'plex', action: 'deploy', status: 'failed', trigger: 'ui', message: raw });
    expect(result?.message).toBe(`Deploy of plex failed: ${'x'.repeat(200)}`);
  });
});

describe('truncateDeployMessage', () => {
  test('returns short messages unchanged', () => {
    expect(truncateDeployMessage('short message')).toBe('short message');
  });

  test('takes only the first line', () => {
    expect(truncateDeployMessage('first line\nsecond line\nthird line')).toBe('first line');
  });

  test('stops at a bare carriage return (compose progress output uses \\r without \\n)', () => {
    expect(truncateDeployMessage('pulling 50%\rpulling 100%\rdone')).toBe('pulling 50%');
  });

  test('stops at the first line of CRLF-delimited text', () => {
    expect(truncateDeployMessage('first line\r\nsecond line')).toBe('first line');
  });

  test('strips control characters including embedded nulls', () => {
    const raw = 'bad' + String.fromCharCode(0) + 'value' + String.fromCharCode(1) + 'here';
    expect(truncateDeployMessage(raw)).toBe('badvaluehere');
  });

  test('truncates to 200 chars', () => {
    const result = truncateDeployMessage('x'.repeat(300));
    expect(result).toHaveLength(200);
    expect(result).toBe('x'.repeat(200));
  });

  test('does not split a surrogate pair at the 200-char boundary', () => {
    const raw = 'x'.repeat(199) + '\u{1F600}' + 'y'.repeat(10);
    expect(truncateDeployMessage(raw)).toBe('x'.repeat(199));
  });

  test('is idempotent for an already-truncated message', () => {
    const once = truncateDeployMessage('x'.repeat(300));
    expect(truncateDeployMessage(once)).toBe(once);
  });
});

describe('createDeployToastGate', () => {
  test('shouldToast returns true the first time a deployId is seen', () => {
    const gate = createDeployToastGate();
    expect(gate.shouldToast(1)).toBe(true);
  });

  test('shouldToast returns false on subsequent calls for the same deployId', () => {
    const gate = createDeployToastGate();
    expect(gate.shouldToast(1)).toBe(true);
    expect(gate.shouldToast(1)).toBe(false);
    expect(gate.shouldToast(1)).toBe(false);
  });

  test('tracks each deployId independently', () => {
    const gate = createDeployToastGate();
    expect(gate.shouldToast(1)).toBe(true);
    expect(gate.shouldToast(2)).toBe(true);
    expect(gate.shouldToast(1)).toBe(false);
    expect(gate.shouldToast(2)).toBe(false);
  });

  test('claim is an alias for shouldToast: pre-claiming suppresses a later shouldToast call', () => {
    const gate = createDeployToastGate();
    expect(gate.claim(5)).toBe(true);
    expect(gate.shouldToast(5)).toBe(false);
  });

  test('release undoes a claim so a later shouldToast can fire again', () => {
    const gate = createDeployToastGate();
    expect(gate.claim(7)).toBe(true);
    gate.release(7);
    expect(gate.shouldToast(7)).toBe(true);
  });

  test('release of an unknown deployId is a no-op', () => {
    const gate = createDeployToastGate();
    gate.release(99);
    expect(gate.shouldToast(99)).toBe(true);
  });

  test('factory instances are independent of each other and of the singleton', () => {
    const gateA = createDeployToastGate();
    const gateB = createDeployToastGate();
    expect(gateA.shouldToast(1)).toBe(true);
    expect(gateB.shouldToast(1)).toBe(true);
  });
});
