import { describe, test, expect } from 'bun:test';
import {
  toHostListItem,
  getAgentImage,
  getAgentImageTag,
  getAgentUpdaterImage,
  normalizeAgentImageTag,
  DEFAULT_AGENT_IMAGE_TAG,
} from '../host-utils';
import type { ManagedHost } from '../../database/repositories/host-repository';

describe('toHostListItem', () => {
  const baseRow: ManagedHost = {
    id: 1,
    name: 'test-host',
    agentUrl: 'http://192.168.1.10:9090',
    capabilities: { docker: true },
    agentVersion: '1.0.0',
    agentImage: null,
    agentImageTag: null,
    status: 'healthy',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
  };

  test('maps DB row to HostListItem', () => {
    const item = toHostListItem(baseRow);
    expect(item).toEqual({
      id: 1,
      name: 'test-host',
      agentUrl: 'http://192.168.1.10:9090',
      capabilities: { docker: true },
      agentVersion: '1.0.0',
      agentImage: null,
      agentImageTag: null,
      status: 'healthy',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  test('applies agentVersion override', () => {
    const item = toHostListItem(baseRow, { agentVersion: '2.0.0' });
    expect(item.agentVersion).toBe('2.0.0');
  });

  test('applies null agentVersion override', () => {
    const item = toHostListItem(baseRow, { agentVersion: null });
    expect(item.agentVersion).toBeNull();
  });

  test('applies status override', () => {
    const item = toHostListItem(baseRow, { status: 'error' });
    expect(item.status).toBe('error');
  });

  test('applies both overrides', () => {
    const item = toHostListItem(baseRow, { agentVersion: '3.0.0', status: 'pending' });
    expect(item.agentVersion).toBe('3.0.0');
    expect(item.status).toBe('pending');
  });

  test('preserves original values when no overrides', () => {
    const item = toHostListItem({ ...baseRow, agentVersion: null, status: 'unhealthy' });
    expect(item.agentVersion).toBeNull();
    expect(item.status).toBe('unhealthy');
  });

  test('converts dates to ISO strings', () => {
    const item = toHostListItem(baseRow);
    expect(item.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(item.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('defaults capabilities to empty object when undefined', () => {
    const row = { ...baseRow, capabilities: undefined as unknown as ManagedHost['capabilities'] };
    const item = toHostListItem(row);
    expect(item.capabilities).toEqual({});
  });

  test('maps capabilities with docker and zfs', () => {
    const row = { ...baseRow, capabilities: { docker: true, zfs: true } };
    const item = toHostListItem(row);
    expect(item.capabilities).toEqual({ docker: true, zfs: true });
  });
});

describe('normalizeAgentImageTag', () => {
  test.each(['latest', 'dev', 'a1b2c3d', '1.2.3', 'v1.2.3-rc.1', 'A_b.c-d'])(
    'keeps the valid tag %s',
    (tag) => {
      expect(normalizeAgentImageTag(tag)).toBe(tag);
    },
  );

  test.each([
    ['', 'empty'],
    ['dev latest', 'whitespace'],
    ['-dev', 'leading dash'],
    ['.dev', 'leading dot'],
    ['dev:latest', 'colon'],
    ['ghcr.io/x/y:dev', 'a full image reference'],
    ['dev\n$(id)', 'shell metacharacters'],
    ['d'.repeat(129), 'over the 128-character limit'],
  ])('falls back to latest for %s (%s)', (raw) => {
    expect(normalizeAgentImageTag(raw)).toBe(DEFAULT_AGENT_IMAGE_TAG);
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 7],
    ['an object', { tag: 'dev' }],
  ])('falls back to latest for %s', (_label, raw) => {
    expect(normalizeAgentImageTag(raw)).toBe(DEFAULT_AGENT_IMAGE_TAG);
  });

  test('accepts a tag exactly at the 128-character limit', () => {
    const tag = 'd'.repeat(128);
    expect(normalizeAgentImageTag(tag)).toBe(tag);
  });
});

describe('agent images', () => {
  // Vite inlines VITE_AGENT_IMAGE_TAG at build time, so the tag cannot be varied here.
  test('pin both images to the build-time tag', () => {
    const tag = getAgentImageTag();
    expect(tag).toBe(DEFAULT_AGENT_IMAGE_TAG);
    expect(getAgentImage()).toBe(`ghcr.io/jaredglaser/homelab-manager-agent:${tag}`);
    expect(getAgentUpdaterImage()).toBe(`ghcr.io/jaredglaser/homelab-manager-agent-updater:${tag}`);
  });
});
