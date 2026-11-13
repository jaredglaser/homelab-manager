import { describe, it, expect } from 'bun:test';
import { missingAgentKeypairError, missingAgentKeypairMessage } from '../agent-messages';

describe('missingAgentKeypairMessage', () => {
  it('names the host and the two controls that fix it', () => {
    expect(missingAgentKeypairMessage('media-server')).toBe(
      'The manager has no keypair for host "media-server", so it cannot sign requests to it. '
        + "Rotate the keypair from this host's keypair dialog, or remove and re-add the host.",
    );
  });

  it('carries the no_keypair code so the UI does not have to match the message', () => {
    const err = missingAgentKeypairError('media-server');
    expect(err.code).toBe('no_keypair');
    expect(err.message).toBe(missingAgentKeypairMessage('media-server'));
  });
});
