// src/lib/deploy/builders/__tests__/trigger-builders.test.ts

import { describe, it, expect } from 'bun:test';
import { GitTriggerBuilder } from '../git-trigger-builder';
import { UITriggerBuilder } from '../ui-trigger-builder';
import type { Manifest } from '@/lib/deploy/types';

const testManifest: Manifest = {
  stacks: {
    plex: { host: 'homeserver', autoDeploy: true },
    traefik: { host: 'homeserver', autoDeploy: false },
    pihole: { host: 'pihole-host', autoDeploy: true },
  },
};

describe('GitTriggerBuilder', () => {
  const builder = new GitTriggerBuilder();

  it('builds DeployRequests for changed stacks with autoDeploy', () => {
    const changedStacks = new Map<string, string>([
      ['plex', 'version: "3"\nservices:\n  plex:\n    image: plexinc/pms-docker'],
      ['traefik', 'version: "3"\nservices:\n  traefik:\n    image: traefik:v3'],
    ]);

    const requests = builder.build({
      manifest: testManifest,
      changedStacks,
      commitSha: 'abc123',
    });

    // plex has autoDeploy: true -> autoApproved: true
    // traefik has autoDeploy: false -> autoApproved: false
    expect(requests).toHaveLength(2);

    const plexReq = requests.find(r => r.stack === 'plex')!;
    expect(plexReq.host).toBe('homeserver');
    expect(plexReq.commitSha).toBe('abc123');
    expect(plexReq.trigger).toBe('git_push');
    expect(plexReq.autoApproved).toBe(true);
    expect(plexReq.action).toBe('deploy');
    expect(plexReq.action === 'deploy' && plexReq.composeContent).toContain('plexinc/pms-docker');

    const traefikReq = requests.find(r => r.stack === 'traefik')!;
    expect(traefikReq.autoApproved).toBe(false);
  });

  it('skips stacks not in manifest', () => {
    const changedStacks = new Map<string, string>([
      ['unknown-stack', 'version: "3"'],
    ]);

    const requests = builder.build({
      manifest: testManifest,
      changedStacks,
      commitSha: 'abc123',
    });

    expect(requests).toHaveLength(0);
  });

  it('returns empty array when no stacks changed', () => {
    const requests = builder.build({
      manifest: testManifest,
      changedStacks: new Map(),
      commitSha: 'abc123',
    });

    expect(requests).toHaveLength(0);
  });
});

describe('UITriggerBuilder', () => {
  const builder = new UITriggerBuilder();

  it('builds a single DeployRequest for a UI deploy action', () => {
    const request = builder.build({
      stack: 'plex',
      host: 'homeserver',
      composeContent: 'version: "3"',
      commitSha: 'abc123',
      action: 'deploy',
    });

    expect(request.stack).toBe('plex');
    expect(request.host).toBe('homeserver');
    expect(request.trigger).toBe('ui');
    expect(request.autoApproved).toBe(true);
    expect(request.action).toBe('deploy');
  });

  it('builds a teardown request', () => {
    const request = builder.build({
      stack: 'plex',
      host: 'homeserver',
      composeContent: '',
      commitSha: 'abc123',
      action: 'teardown',
    });

    expect(request.action).toBe('teardown');
    expect(request.trigger).toBe('ui');
  });

  it('builds a manual_rollback request', () => {
    const request = builder.buildRollback({
      stack: 'plex',
      host: 'homeserver',
      composeContent: 'version: "3"',
      commitSha: 'old-sha',
    });

    expect(request.action).toBe('deploy');
    expect(request.trigger).toBe('manual_rollback');
    expect(request.commitSha).toBe('old-sha');
  });
});
