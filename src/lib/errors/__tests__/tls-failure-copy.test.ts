import { describe, it, expect } from 'bun:test';
import { TLS_FAILURE_CODES } from '@homelab-manager/agent/types';
import { hostFailureMessage } from '../host-failure-copy';
import { tlsFailureCopy, tlsFailureGuidance, tlsFailureMessage } from '../tls-failure-copy';

describe('tlsFailureCopy', () => {
  it('has copy for every code, so a new code cannot ship without a sentence', () => {
    for (const code of TLS_FAILURE_CODES) {
      const { headline } = tlsFailureCopy(code);
      expect((typeof headline === 'function' ? headline('HTTP 502') : headline).length).toBeGreaterThan(0);
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

  it('says something other than the agent answered, with the status and the next step', () => {
    expect(tlsFailureMessage('agent_not_answering', 'HTTP 502')).toBe(
      'Something other than the agent answered (HTTP 502). Check that the agent URL points at the agent and that any proxy in front of it is running, then try again.',
    );
    expect(tlsFailureMessage('agent_not_answering')).toBe(
      'Something other than the agent answered. Check that the agent URL points at the agent and that any proxy in front of it is running, then try again.',
    );
    expect(tlsFailureGuidance('agent_not_answering', 'HTTP 502').retryUseless).toBe(false);
  });

  it('says the agent URL redirected, and points at the scheme and port', () => {
    expect(tlsFailureMessage('unexpected_redirect', 'HTTP 301')).toBe(
      'The agent URL redirected the request instead of answering it. Check that the URL stored for this host uses the right scheme (http or https) and the agent port, and that no proxy redirects it, then retry.',
    );
    expect(tlsFailureGuidance('unexpected_redirect').retryUseless).toBe(true);
  });

  it('keeps the not-answering sentence the same as the host update surface shows', () => {
    expect(tlsFailureMessage('agent_not_answering', 'HTTP 504')).toBe(hostFailureMessage('agent_not_answering', 'HTTP 504'));
  });
});
