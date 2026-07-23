import { describe, it, expect } from 'bun:test';
import { stackStatusChannel, serializeStackStatusEvent } from '../stack-status';
import type { StackBroadcastEvent } from '@/lib/stacks/stack-status-broadcast-service';

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

  it('validates a deploy_changed frame without outcome fields (legacy payload)', () => {
    const result = stackStatusChannel.schema.safeParse({ type: 'deploy_changed', stack: 'plex', host: 'server1' });
    expect(result.success).toBe(true);
  });

  it('validates a deploy_changed frame with outcome fields', () => {
    const result = stackStatusChannel.schema.safeParse({
      type: 'deploy_changed',
      stack: 'plex',
      host: 'server1',
      deployId: 42,
      status: 'failed',
      action: 'deploy',
      trigger: 'git_push',
      message: 'agent unreachable',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a deploy_changed frame with an invalid status', () => {
    const result = stackStatusChannel.schema.safeParse({
      type: 'deploy_changed',
      stack: 'plex',
      host: 'server1',
      status: 'bogus',
    });
    expect(result.success).toBe(false);
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

describe('serializeStackStatusEvent', () => {
  it('serializes a status event as the bare entries array', () => {
    const event: StackBroadcastEvent = {
      type: 'status',
      entries: [{ stack: 'plex', host: 'server1', containers: [], updated_at: '2026-03-21T00:00:00Z' }],
    };
    expect(serializeStackStatusEvent(event)).toBe(`data: ${JSON.stringify(event.entries)}\n\n`);
  });

  it('serializes a legacy deploy_changed event without outcome fields', () => {
    const event: StackBroadcastEvent = { type: 'deploy_changed', stack: 'plex', host: 'server1' };
    const frame = serializeStackStatusEvent(event);
    const payload = JSON.parse(frame.slice('data: '.length).trim());
    expect(payload).toEqual({ type: 'deploy_changed', stack: 'plex', host: 'server1' });
  });

  it('serializes an enriched deploy_changed event with all outcome fields', () => {
    const event: StackBroadcastEvent = {
      type: 'deploy_changed',
      stack: 'plex',
      host: 'server1',
      deployId: 42,
      status: 'failed',
      action: 'deploy',
      trigger: 'git_push',
      message: 'agent unreachable',
    };
    const frame = serializeStackStatusEvent(event);
    const payload = JSON.parse(frame.slice('data: '.length).trim());
    expect(payload).toEqual({
      type: 'deploy_changed',
      stack: 'plex',
      host: 'server1',
      deployId: 42,
      status: 'failed',
      action: 'deploy',
      trigger: 'git_push',
      message: 'agent unreachable',
    });
  });
});
