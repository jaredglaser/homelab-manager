import { describe, it, expect, afterEach } from 'bun:test';

import { createConnectionHandler, type MuxMockClient } from '@/lib/mock/handlers/ws';
import { settingsUpdates, stackStatusUpdates } from '@/lib/mock/live-updates';
import { generateDefaultSettings } from '@/lib/mock/generators/settings';
import { generateStackStatusEntry } from '@/lib/mock/generators/stacks';
import { settingsChannel } from '@/lib/sse/channels/settings';
import { stackStatusChannel } from '@/lib/sse/channels/stack-status';
import { dockerInventoryChannel } from '@/lib/sse/channels/docker-inventory';

interface MuxFrame {
  type: string;
  topic?: string;
  kind?: string;
  payload?: unknown;
  ref?: number;
  ok?: boolean;
  error?: string;
}

const openConnections: Array<() => void> = [];

afterEach(() => {
  for (const close of openConnections.splice(0)) close();
});

function connect() {
  const frames: MuxFrame[] = [];
  const listeners = new Map<string, (event: { data?: unknown }) => void>();
  const client: MuxMockClient = {
    send: (data) => {
      frames.push(JSON.parse(data) as MuxFrame);
    },
    addEventListener: (type, listener) => {
      listeners.set(type, listener);
    },
  };
  createConnectionHandler({ client });
  const close = () => listeners.get('close')?.({});
  openConnections.push(close);
  return {
    frames,
    command(type: 'sub' | 'unsub', topics: string[]) {
      listeners.get('message')?.({ data: JSON.stringify({ type, ref: 7, topics }) });
    },
    dataFrames(topic: string) {
      return frames.filter((f) => f.type === 'event' && f.topic === topic && f.kind === 'data');
    },
    close,
  };
}

describe('mock mux ws handlers', () => {
  it('acks subscriptions', () => {
    const conn = connect();
    conn.command('sub', ['settings']);
    expect(conn.frames.at(-1)).toEqual({ type: 'ack', ref: 7, ok: true });
  });

  it('serves settings init on subscribe and re-delivers it on re-subscribe', () => {
    const conn = connect();
    conn.command('sub', ['settings']);
    conn.command('sub', ['settings']);
    const inits = conn.dataFrames('settings');
    expect(inits.length).toBe(2);
    for (const frame of inits) {
      const payload = frame.payload as {
        type: string;
        settings: Record<string, string>;
      };
      expect(payload.type).toBe('init');
      expect(payload.settings).toEqual(generateDefaultSettings());
      expect(settingsChannel.schema.safeParse(payload).success).toBe(true);
    }
  });

  it('pushes live settings changes and validates them against the channel schema', () => {
    const conn = connect();
    conn.command('sub', ['settings']);
    settingsUpdates.emit({ type: 'change', key: 'updateIntervalMs', value: '2000' });
    const change = conn.dataFrames('settings').at(-1)!;
    expect(change.payload).toEqual({ type: 'change', key: 'updateIntervalMs', value: '2000' });
    expect(settingsChannel.schema.safeParse(change.payload).success).toBe(true);
  });

  it('stops settings updates after unsubscribe', () => {
    const conn = connect();
    conn.command('sub', ['settings']);
    conn.command('unsub', ['settings']);
    const before = conn.dataFrames('settings').length;
    settingsUpdates.emit({ type: 'change', key: 'k', value: 'v' });
    expect(conn.dataFrames('settings').length).toBe(before);
  });

  it('stops updates after the connection closes', () => {
    const conn = connect();
    conn.command('sub', ['settings', 'stack-status']);
    conn.close();
    const before = conn.frames.length;
    settingsUpdates.emit({ type: 'change', key: 'k', value: 'v' });
    stackStatusUpdates.emit({ type: 'deploy_changed', stack: 'plex', host: 'nas01' });
    expect(conn.frames.length).toBe(before);
  });

  it('serves stack-status state on subscribe and re-delivers it on re-subscribe', () => {
    const conn = connect();
    conn.command('sub', ['stack-status']);
    conn.command('sub', ['stack-status']);
    const inits = conn.dataFrames('stack-status');
    expect(inits.length).toBe(2);
    for (const frame of inits) {
      const entries = frame.payload as Array<{
        stack: string;
        host: string;
        containers: unknown[];
      }>;
      expect(Array.isArray(entries)).toBe(true);
      expect(entries.length).toBeGreaterThan(0);
      const traefik = entries.find((e) => e.stack === 'traefik' && e.host === 'nas01');
      expect(traefik?.containers.length).toBe(2);
      expect(stackStatusChannel.schema.safeParse(frame.payload).success).toBe(true);
    }
    const withoutTimestamps = (payload: unknown) =>
      (payload as Array<{ updated_at: string }>).map((e) => ({ ...e, updated_at: '' }));
    expect(withoutTimestamps(inits[1].payload)).toEqual(withoutTimestamps(inits[0].payload));
  });

  it('pushes live stack-status updates and deploy changes', () => {
    const conn = connect();
    conn.command('sub', ['stack-status']);
    const entry = generateStackStatusEntry(new Date(), 'nas01', 'plex')!;
    stackStatusUpdates.emit([entry]);
    stackStatusUpdates.emit({
      type: 'deploy_changed',
      stack: 'plex',
      host: 'nas01',
      outcome: { deployId: 1, status: 'succeeded', action: 'deploy', trigger: 'ui' },
    });
    const updates = conn.dataFrames('stack-status');
    expect(updates.at(-2)!.payload).toEqual([entry]);
    expect(updates.at(-1)!.payload).toEqual({
      type: 'deploy_changed',
      stack: 'plex',
      host: 'nas01',
      outcome: { deployId: 1, status: 'succeeded', action: 'deploy', trigger: 'ui' },
    });
    for (const frame of updates) {
      expect(stackStatusChannel.schema.safeParse(frame.payload).success).toBe(true);
    }
  });

  it('keeps serving inventory and logs topics on the wire schemas', () => {
    const conn = connect();
    conn.command('sub', ['inventory']);
    const init = conn.dataFrames('inventory').at(-1)!;
    expect((init.payload as { type: string }).type).toBe('init');
    expect(dockerInventoryChannel.schema.safeParse(init.payload).success).toBe(true);
  });

  it('rejects unknown topics with a gone error frame', () => {
    const conn = connect();
    conn.command('sub', ['bogus']);
    const error = conn.frames.find((f) => f.kind === 'error');
    expect(error?.payload).toEqual({ message: 'Unsupported topic: bogus', gone: true });
  });
});
