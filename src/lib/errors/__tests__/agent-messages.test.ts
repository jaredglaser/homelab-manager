import { describe, it, expect } from 'bun:test';
import { missingAgentKeypairMessage } from '../agent-messages';

describe('missingAgentKeypairMessage', () => {
  it('names the host and the two controls that fix it', () => {
    expect(missingAgentKeypairMessage('media-server')).toBe(
      'The manager has no keypair for host "media-server", so it cannot sign requests to it. '
        + "Rotate the keypair from this host's keypair dialog, or remove and re-add the host.",
    );
  });
});
