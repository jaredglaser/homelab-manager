import { describe, it, expect } from 'bun:test';
import { AGENT_ROUTE_FAILURE_CODES, isAgentRouteFailureCode, isAgentUpdateFailureCode } from '@homelab-manager/agent/types';
import { HOST_PROBE_FAILURE_CODES, hostFailureDetail, hostFailureMessage, isHostFailureCode, probeFailureCode } from '../host-failure-copy';

describe('probeFailureCode', () => {
  it('keeps the probe reason and falls back when the probe named none', () => {
    expect(probeFailureCode({ reason: 'awaiting-enrollment' })).toBe('awaiting-enrollment');
    expect(probeFailureCode({})).toBe('health_check_failed');
  });
});

describe('isHostFailureCode', () => {
  it('accepts the codes that have copy', () => {
    for (const code of [...HOST_PROBE_FAILURE_CODES, 'agent_did_not_restart', 'version_unconfirmed', 'image_unconfirmed'] as const) {
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

describe('image_unconfirmed', () => {
  it('pins the sentence the operator reads', () => {
    expect(hostFailureMessage('image_unconfirmed')).toBe(
      'The agent reports the same version as before and does not report which image it runs, so the update could not be confirmed. Check which image the agent container runs on the host, and update it by hand there if it is still the old one.',
    );
  });
});

describe('update_already_running', () => {
  it('pins the sentence the operator reads, with no detail after it', () => {
    expect(hostFailureMessage('update_already_running', 'ignored')).toBe(
      'An update is already running for this host. Wait for it to finish.',
    );
  });
});

describe('agent_not_answering', () => {
  it('pins the sentence the operator reads, with the status named in the headline', () => {
    expect(hostFailureMessage('agent_not_answering', 'HTTP 502')).toBe(
      'Something other than the agent answered (HTTP 502). Check that the agent URL points at the agent and that any proxy in front of it is running, then try again.',
    );
  });

  it('reads whole when no status is known', () => {
    expect(hostFailureMessage('agent_not_answering')).toBe(
      'Something other than the agent answered. Check that the agent URL points at the agent and that any proxy in front of it is running, then try again.',
    );
  });

  it('does not repeat the status after the fix', () => {
    expect(hostFailureDetail('agent_not_answering', 'HTTP 502')).toBeNull();
  });

  it('keeps internal vocabulary out of the copy', () => {
    expect(hostFailureMessage('agent_not_answering', 'HTTP 502')).not.toMatch(/header|endpoint|json|code|body/i);
  });

  it('is a manager-side code: the agent never sends it, so it is in no agent code set and no probe code set', () => {
    expect(isAgentRouteFailureCode('agent_not_answering')).toBe(false);
    expect(isAgentUpdateFailureCode('agent_not_answering')).toBe(false);
    expect(AGENT_ROUTE_FAILURE_CODES as readonly string[]).not.toContain('agent_not_answering');
    expect(HOST_PROBE_FAILURE_CODES as readonly string[]).not.toContain('agent_not_answering');
  });
});
