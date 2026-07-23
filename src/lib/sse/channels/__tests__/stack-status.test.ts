import { describe, it, expect } from 'bun:test';
import { stackStatusChannel } from '../stack-status';

describe('stackStatusChannel', () => {
  it('exposes the url and errorEvent used by the route and the client', () => {
    expect(stackStatusChannel.url).toBe('/api/stack-status');
    expect(stackStatusChannel.errorEvent).toBe('stack_status_error');
  });

  it('validates a status-entries array frame', () => {
    const result = stackStatusChannel.schema.safeParse([
      {
        stack: 'plex',
        host: 'server1',
        containers: [{ id: 'abc', name: 'plex', status: 'running', image: 'plexinc/pms-docker', service: 'plex' }],
        updated_at: '2026-03-21T00:00:00Z',
      },
    ]);
    expect(result.success).toBe(true);
  });

  it('validates a deploy_changed frame', () => {
    const result = stackStatusChannel.schema.safeParse({ type: 'deploy_changed', stack: 'plex', host: 'server1' });
    expect(result.success).toBe(true);
  });

  it('rejects a container missing required fields', () => {
    const result = stackStatusChannel.schema.safeParse([
      { stack: 'plex', host: 'server1', containers: [{ id: 'abc' }], updated_at: '2026-03-21T00:00:00Z' },
    ]);
    expect(result.success).toBe(false);
  });

  it('revive is the identity (no Date fields on the wire)', () => {
    const message = [{ stack: 'plex', host: 'server1', containers: [], updated_at: '2026-03-21T00:00:00Z' }];
    expect(stackStatusChannel.revive!(message)).toBe(message);
  });
});
