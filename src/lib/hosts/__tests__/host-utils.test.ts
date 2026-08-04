import { describe, test, expect, afterEach } from 'bun:test';
import {
  toHostListItem,
  getAgentImage,
  getAgentImageTag,
  getAgentUpdaterImage,
  normalizeAgentImageTag,
  DEFAULT_AGENT_IMAGE_TAG,
} from '@/lib/hosts/host-utils';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';
import { generateAgentStackEnv } from '@/lib/templates/agent-stack-compose';

describe('toHostListItem', () => {
  const baseRow: ManagedHost = {
    id: 1,
    name: 'test-host',
    agentUrl: 'http://192.168.1.10:9090',
    capabilities: { docker: true },
    agentVersion: '1.0.0',
    agentImage: null,
    agentImageTag: null,
    sshHost: null,
    sshUser: null,
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
      sshHost: null,
      sshUser: null,
      status: 'healthy',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  test('carries the reported agent image through to the API shape', () => {
    const row = {
      ...baseRow,
      agentImage: 'ghcr.io/jaredglaser/homelab-manager-agent:dev',
      agentImageTag: 'dev',
    };
    const item = toHostListItem(row);
    expect(item.agentImage).toBe('ghcr.io/jaredglaser/homelab-manager-agent:dev');
    expect(item.agentImageTag).toBe('dev');
  });

  test('carries the SSH target through to the wire type', () => {
    const item = toHostListItem({ ...baseRow, sshHost: '10.0.0.5', sshUser: 'deploy' });
    expect(item.sshHost).toBe('10.0.0.5');
    expect(item.sshUser).toBe('deploy');
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
  const originalTag = import.meta.env.VITE_AGENT_IMAGE_TAG;

  function setBuildTag(tag: string | undefined) {
    if (tag === undefined) {
      delete import.meta.env.VITE_AGENT_IMAGE_TAG;
    } else {
      import.meta.env.VITE_AGENT_IMAGE_TAG = tag;
    }
  }

  afterEach(() => {
    setBuildTag(originalTag);
  });

  test('defaults both images to latest when the build set no tag', () => {
    setBuildTag(undefined);
    expect(getAgentImageTag()).toBe(DEFAULT_AGENT_IMAGE_TAG);
    expect(getAgentImage()).toBe('ghcr.io/jaredglaser/homelab-manager-agent:latest');
    expect(getAgentUpdaterImage()).toBe('ghcr.io/jaredglaser/homelab-manager-agent-updater:latest');
  });

  test('pins both images to the tag the build baked in', () => {
    setBuildTag('dev');
    expect(getAgentImageTag()).toBe('dev');
    expect(getAgentImage()).toBe('ghcr.io/jaredglaser/homelab-manager-agent:dev');
    expect(getAgentUpdaterImage()).toBe('ghcr.io/jaredglaser/homelab-manager-agent-updater:dev');
  });

  test('pins to a release tag', () => {
    setBuildTag('v1.2.3');
    expect(getAgentImage()).toBe('ghcr.io/jaredglaser/homelab-manager-agent:v1.2.3');
  });

  test('routes a malformed build tag through the guard rather than emitting it', () => {
    setBuildTag('dev latest');
    expect(getAgentImageTag()).toBe(DEFAULT_AGENT_IMAGE_TAG);
    expect(getAgentImage()).toBe('ghcr.io/jaredglaser/homelab-manager-agent:latest');
  });
});

describe('generated enrollment files carry the build tag', () => {
  const originalTag = import.meta.env.VITE_AGENT_IMAGE_TAG;

  afterEach(() => {
    if (originalTag === undefined) {
      delete import.meta.env.VITE_AGENT_IMAGE_TAG;
    } else {
      import.meta.env.VITE_AGENT_IMAGE_TAG = originalTag;
    }
  });

  test('a dev dashboard writes dev images into the agent .env', () => {
    import.meta.env.VITE_AGENT_IMAGE_TAG = 'dev';
    const env = generateAgentStackEnv({
      hostName: 'test-host',
      agentTrustedPubkey: 'pubkey',
      agentImage: getAgentImage(),
      agentUpdaterImage: getAgentUpdaterImage(),
      capabilities: { docker: true, zfs: false },
    });
    expect(env).toContain('AGENT_IMAGE=ghcr.io/jaredglaser/homelab-manager-agent:dev\n');
    expect(env).toContain('AGENT_UPDATER_IMAGE=ghcr.io/jaredglaser/homelab-manager-agent-updater:dev\n');
  });
});
