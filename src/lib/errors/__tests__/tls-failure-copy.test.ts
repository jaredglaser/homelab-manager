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

  it('flags which failures retrying cannot fix, for the surface to act on', () => {
    const retryUseless = [
      'pin_missing',
      'cert_unverifiable',
      'not_configured_for_tls',
      'signature_invalid',
      'no_keypair',
      'restart_unavailable',
      'invalid_request',
    ] as const;
    for (const code of retryUseless) {
      expect(tlsFailureGuidance(code).retryUseless).toBe(true);
    }
    expect(tlsFailureGuidance('poll_timeout').retryUseless).toBe(false);
  });

  it('never appends a retry hint, because only the surface knows which control it offers', () => {
    for (const code of TLS_FAILURE_CODES) {
      expect(tlsFailureMessage(code)).not.toMatch(/to try again/i);
    }
  });

  it('carries the runbook anchor only where the message cannot carry the whole fix', () => {
    expect(tlsFailureGuidance('pin_missing').docAnchor).toBe('agent-tls-recovery-the-manager-lost-it');
    expect(tlsFailureGuidance('cert_unverifiable').docAnchor).toBe('agent-tls-recovery-the-manager-lost-it');
    // An unreachable agent may be one that already enrolled and now serves HTTPS only.
    expect(tlsFailureGuidance('agent_unreachable').docAnchor).toBe('agent-tls-recovery-the-manager-lost-it');
    expect(tlsFailureGuidance('poll_timeout').docAnchor).toBeUndefined();
  });

  it('appends the detail only where it carries the diagnosis', () => {
    expect(tlsFailureMessage('unexpected_agent_response', 'the agent said no')).toContain('the agent said no');
    expect(tlsFailureMessage('no_keypair', 'internal detail')).not.toContain('internal detail');
  });
});
