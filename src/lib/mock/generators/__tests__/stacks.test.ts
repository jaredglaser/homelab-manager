import { describe, it, expect } from 'bun:test';

import { generateStackStatusEntry, generateStackStatusSnapshot } from '@/lib/mock/generators/stacks';
import { listStacks } from '@/lib/mock/functions/stacks.functions';
import { stackStatusChannel } from '@/lib/sse/channels/stack-status';

describe('generateStackStatusSnapshot', () => {
  it('covers every demo stack with its declared containers', async () => {
    const summaries = await listStacks();
    const entries = generateStackStatusSnapshot(new Date());
    expect(entries.length).toBe(summaries.length);
    for (const summary of summaries) {
      const entry = entries.find((e) => e.stack === summary.name && e.host === summary.host);
      expect(entry).toBeDefined();
      expect(entry!.containers.length).toBe(summary.containerCount);
    }
  });

  it('produces entries matching the stack-status wire schema', () => {
    const entries = generateStackStatusSnapshot(new Date());
    expect(stackStatusChannel.schema.safeParse(entries).success).toBe(true);
  });

  it('maps compose services and docker container fields into stack containers', () => {
    const entry = generateStackStatusSnapshot(new Date()).find((e) => e.stack === 'traefik');
    expect(entry!.containers.map((c) => c.name).sort()).toEqual(['nginx-proxy', 'traefik']);
    for (const container of entry!.containers) {
      expect(typeof container.id).toBe('string');
      expect(typeof container.status).toBe('string');
      expect(typeof container.image).toBe('string');
      expect(Array.isArray(container.ports)).toBe(true);
      expect(Array.isArray(container.mounts)).toBe(true);
    }
    expect(new Date(entry!.updated_at).toISOString()).toBe(entry!.updated_at);
  });
});

describe('generateStackStatusEntry', () => {
  it('returns the same entry as the snapshot for one stack', () => {
    const now = new Date();
    const snapshot = generateStackStatusSnapshot(now).find((e) => e.stack === 'plex') ?? null;
    expect(generateStackStatusEntry(now, 'nas01', 'plex')).toEqual(snapshot);
  });

  it('returns null for unknown stacks and mismatched hosts', () => {
    const now = new Date();
    expect(generateStackStatusEntry(now, 'nas01', 'nope')).toBeNull();
    expect(generateStackStatusEntry(now, 'server02', 'plex')).toBeNull();
  });
});
