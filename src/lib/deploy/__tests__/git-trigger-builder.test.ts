import { describe, it, expect } from 'bun:test';
import { GitTriggerBuilder } from '../builders/git-trigger-builder';
import type { Manifest } from '@/lib/deploy/types';

describe('GitTriggerBuilder', () => {
  const builder = new GitTriggerBuilder();

  const manifest: Manifest = {
    stacks: {
      plex: { host: 'homeserver', autoDeploy: true },
      sonarr: { host: 'homeserver', autoDeploy: false },
    },
  };

  it('builds a DeployRequest per changed stack found in the manifest', () => {
    const changedStacks = new Map([
      ['plex', 'services:\n  plex:\n    image: plexinc/pms-docker'],
      ['sonarr', 'services:\n  sonarr:\n    image: sonarr:latest'],
    ]);

    const requests = builder.build({ manifest, changedStacks, commitSha: 'abc123' });

    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({
      stack: 'plex',
      host: 'homeserver',
      composeContent: 'services:\n  plex:\n    image: plexinc/pms-docker',
      commitSha: 'abc123',
      envContent: '',
      action: 'deploy',
      trigger: 'git_push',
      autoApproved: true,
    });
    expect(requests[1]).toEqual({
      stack: 'sonarr',
      host: 'homeserver',
      composeContent: 'services:\n  sonarr:\n    image: sonarr:latest',
      commitSha: 'abc123',
      envContent: '',
      action: 'deploy',
      trigger: 'git_push',
      autoApproved: false,
    });
  });

  it('skips changed stacks not present in the manifest', () => {
    const changedStacks = new Map([
      ['unknown-stack', 'services:\n  foo:\n    image: foo'],
      ['plex', 'services:\n  plex:\n    image: plexinc/pms-docker'],
    ]);

    const requests = builder.build({ manifest, changedStacks, commitSha: 'def456' });

    expect(requests).toHaveLength(1);
    expect(requests[0].stack).toBe('plex');
  });

  it('returns an empty array when no changed stacks match the manifest', () => {
    const changedStacks = new Map([['nonexistent', 'content']]);
    const requests = builder.build({ manifest, changedStacks, commitSha: 'xyz' });
    expect(requests).toEqual([]);
  });

  it('returns an empty array for empty changedStacks', () => {
    const requests = builder.build({ manifest, changedStacks: new Map(), commitSha: 'xyz' });
    expect(requests).toEqual([]);
  });
});
