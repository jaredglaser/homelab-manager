import { describe, it, expect } from 'bun:test';
import { missingAgentKeypairMessage } from '../agent-messages';

describe('missingAgentKeypairMessage', () => {
  it('names the host, so the operator knows which one to fix', () => {
    expect(missingAgentKeypairMessage('media-server')).toContain('media-server');
  });

  it('names a control that exists, and never advises re-enrolling', () => {
    const message = missingAgentKeypairMessage('media-server');
    expect(message).toContain('keypair dialog');
    // The wording this replaced told the operator to re-enroll the agent, which no control offers.
    expect(message).not.toMatch(/re-?enroll/i);
  });
});
