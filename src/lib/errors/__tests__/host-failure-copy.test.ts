import { describe, it, expect } from 'bun:test';
import { HOST_PROBE_FAILURE_CODES, hostFailureDetail, hostFailureMessage, isHostFailureCode, probeFailureCode } from '../host-failure-copy';

describe('probeFailureCode', () => {
  it('keeps the probe reason and falls back when the probe named none', () => {
    expect(probeFailureCode({ reason: 'awaiting-enrollment' })).toBe('awaiting-enrollment');
    expect(probeFailureCode({})).toBe('health_check_failed');
  });
});

describe('isHostFailureCode', () => {
  it('accepts the codes that have copy', () => {
    for (const code of [...HOST_PROBE_FAILURE_CODES, 'agent_did_not_restart', 'version_unconfirmed'] as const) {
      expect(isHostFailureCode(code)).toBe(true);
    }
  });

  it.each([['an unknown code', 'code_from_a_newer_server'], ['a prototype key', 'toString'], ['a number', 1], ['undefined', undefined]])(
    'rejects %s',
    (_label, value) => {
      expect(isHostFailureCode(value)).toBe(false);
    },
  );
});

describe('hostFailureDetail', () => {
  it('returns the detail only for a code whose copy does not already name the cause', () => {
    expect(hostFailureDetail('offline', 'timed out')).toBe('timed out');
    expect(hostFailureDetail('awaiting-enrollment', 'timed out')).toBeNull();
    expect(hostFailureDetail('offline', '')).toBeNull();
    expect(hostFailureDetail('offline')).toBeNull();
  });
});

describe('hostFailureMessage', () => {
  it('appends the detail after the fix for a code that shows it, and omits it for one that does not', () => {
    expect(hostFailureMessage('health_check_failed', 'boom')).toBe(
      'The host health check did not pass. Check the agent logs, then check again. boom',
    );
    expect(hostFailureMessage('awaiting-enrollment', 'boom')).toBe(
      'The agent is serving plain HTTP because it holds no certificate yet. Enroll a certificate for this host, then check again.',
    );
  });
});
