import { describe, it, expect } from 'bun:test';
import { TLS_FAILURE_CODES } from '@homelab-manager/agent/types';
import { tlsFailureCopy, tlsFailureGuidance, tlsFailureMessage } from '../tls-failure-copy';

describe('tlsFailureCopy', () => {
  it('has copy for every code, so a new code cannot ship without a sentence', () => {
    for (const code of TLS_FAILURE_CODES) {
      expect(tlsFailureCopy(code).headline.length).toBeGreaterThan(0);
      expect(tlsFailureCopy(code).fix.length).toBeGreaterThan(0);
    }
  });

  it('withholds the re-run hint when retrying cannot change the outcome', () => {
    const retryUseless = [
      'pin_missing',
      'not_configured_for_tls',
      'signature_invalid',
      'no_keypair',
      'restart_unavailable',
      'invalid_request',
    ] as const;
    for (const code of retryUseless) {
      expect(tlsFailureCopy(code).retryUseless).toBe(true);
      expect(tlsFailureMessage(code)).not.toContain('Use Re-run provisioning');
    }
    expect(tlsFailureMessage('poll_timeout')).toContain('Use Re-run provisioning');
  });

  it('carries the runbook anchor only where the message cannot carry the whole fix', () => {
    expect(tlsFailureGuidance('pin_missing').docAnchor).toBe('agent-tls-recovery-the-manager-lost-it');
    expect(tlsFailureGuidance('poll_timeout').docAnchor).toBeUndefined();
  });

  it('appends the detail only where it carries the diagnosis', () => {
    expect(tlsFailureMessage('unexpected_agent_response', 'the agent said no')).toContain('the agent said no');
    expect(tlsFailureMessage('no_keypair', 'internal detail')).not.toContain('internal detail');
  });
});
