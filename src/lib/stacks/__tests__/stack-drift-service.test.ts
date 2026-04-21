import { describe, expect, it, mock } from 'bun:test';
import type { DeployRecord } from '@/lib/deploy/types';
import {
  buildStackDriftReport,
  getAllowedStackDriftResolutions,
  resolveStackDriftItem,
  type RepoStackSnapshot,
} from '@/lib/stacks/stack-drift-service';

const baseDeploy = (overrides?: Partial<DeployRecord>): DeployRecord => ({
  id: 1,
  stack: 'plex',
  host: 'alpha',
  commitSha: 'sha-1',
  composeHash: 'repo-hash',
  envHash: 'env-hash',
  status: 'succeeded',
  trigger: 'ui',
  action: 'deploy',
  forceRecreate: false,
  logs: null,
  createdAt: new Date('2026-04-21T00:00:00Z'),
  postSuccess: null,
  ...overrides,
});

describe('buildStackDriftReport', () => {
  it('classifies ghost drift when repo stack is missing on the agent', () => {
    const report = buildStackDriftReport({
      repoStacks: [
        {
          stack: 'plex',
          host: 'alpha',
          autoDeploy: true,
          composeContent: 'services: {}',
          composeHash: 'repo-hash',
        },
      ],
      hosts: [{ name: 'alpha', dockerEnabled: true }],
      latestDeploys: [baseDeploy()],
      agentStacksByHost: new Map([['alpha', []]]),
      scanErrors: [],
    });

    expect(report.items).toEqual([
      expect.objectContaining({
        host: 'alpha',
        stack: 'plex',
        kind: 'ghost',
        repoComposeHash: 'repo-hash',
        latestDeployStatus: 'succeeded',
      }),
    ]);
    expect(report.summary).toEqual({
      total: 1,
      ghost: 1,
      untracked: 0,
      content: 0,
    });
  });

  it('classifies untracked drift when the agent has a stack missing from the repo', () => {
    const report = buildStackDriftReport({
      repoStacks: [],
      hosts: [{ name: 'alpha', dockerEnabled: true }],
      latestDeploys: [],
      agentStacksByHost: new Map([[
        'alpha',
        [{ name: 'grafana', hasComposeFile: true, composeHash: 'agent-hash' }],
      ]]),
      scanErrors: [],
    });

    expect(report.items).toEqual([
      expect.objectContaining({
        host: 'alpha',
        stack: 'grafana',
        kind: 'untracked',
        agentComposeHash: 'agent-hash',
        latestDeployStatus: null,
      }),
    ]);
  });

  it('classifies content drift when repo and agent hashes differ', () => {
    const report = buildStackDriftReport({
      repoStacks: [
        {
          stack: 'plex',
          host: 'alpha',
          autoDeploy: false,
          composeContent: 'services: {}',
          composeHash: 'repo-hash',
        },
      ],
      hosts: [{ name: 'alpha', dockerEnabled: true }],
      latestDeploys: [baseDeploy({ status: 'failed' })],
      agentStacksByHost: new Map([[
        'alpha',
        [{ name: 'plex', hasComposeFile: true, composeHash: 'agent-hash' }],
      ]]),
      scanErrors: [],
    });

    expect(report.items).toEqual([
      expect.objectContaining({
        host: 'alpha',
        stack: 'plex',
        kind: 'content',
        repoComposeHash: 'repo-hash',
        agentComposeHash: 'agent-hash',
        latestDeployStatus: 'failed',
      }),
    ]);
  });

  it('sorts items deterministically by host, stack, then kind', () => {
    const report = buildStackDriftReport({
      repoStacks: [
        { stack: 'plex', host: 'bravo', autoDeploy: false, composeContent: '', composeHash: 'b-plex' },
        { stack: 'grafana', host: 'alpha', autoDeploy: false, composeContent: '', composeHash: 'a-gr' },
      ],
      hosts: [
        { name: 'bravo', dockerEnabled: true },
        { name: 'alpha', dockerEnabled: true },
      ],
      latestDeploys: [],
      agentStacksByHost: new Map([
        ['bravo', [{ name: 'sonarr', hasComposeFile: true, composeHash: 'b-sonarr' }]],
        ['alpha', [{ name: 'radarr', hasComposeFile: true, composeHash: 'a-radarr' }]],
      ]),
      scanErrors: [],
    });

    expect(report.items.map((i) => `${i.host}/${i.stack}/${i.kind}`)).toEqual([
      'alpha/grafana/ghost',
      'alpha/radarr/untracked',
      'bravo/plex/ghost',
      'bravo/sonarr/untracked',
    ]);
  });

  it('skips hosts that do not have docker capability', () => {
    const report = buildStackDriftReport({
      repoStacks: [
        { stack: 'plex', host: 'noDocker', autoDeploy: false, composeContent: '', composeHash: 'repo-hash' },
      ],
      hosts: [{ name: 'noDocker', dockerEnabled: false }],
      latestDeploys: [],
      agentStacksByHost: new Map(),
      scanErrors: [],
    });

    expect(report.items).toEqual([]);
    expect(report.summary.total).toBe(0);
  });

  it('skips drift classification for hosts with scan errors and reports the error', () => {
    const report = buildStackDriftReport({
      repoStacks: [
        {
          stack: 'plex',
          host: 'alpha',
          autoDeploy: false,
          composeContent: 'services: {}',
          composeHash: 'repo-hash',
        },
      ],
      hosts: [{ name: 'alpha', dockerEnabled: true }],
      latestDeploys: [baseDeploy()],
      agentStacksByHost: new Map(),
      scanErrors: [{ host: 'alpha', message: 'agent unreachable' }],
    });

    expect(report.items).toEqual([]);
    expect(report.scanErrors).toEqual([{ host: 'alpha', message: 'agent unreachable' }]);
  });
});

describe('getAllowedStackDriftResolutions', () => {
  it('does not allow trusting the repo for untracked stacks', () => {
    expect(getAllowedStackDriftResolutions('untracked')).toEqual(['trust_agent', 'remove']);
  });

  it('allows all actions for ghost and content drift', () => {
    expect(getAllowedStackDriftResolutions('ghost')).toEqual(['trust_repo', 'trust_agent', 'remove']);
    expect(getAllowedStackDriftResolutions('content')).toEqual(['trust_repo', 'trust_agent', 'remove']);
  });
});

describe('resolveStackDriftItem', () => {
  const repoStack: RepoStackSnapshot = {
    stack: 'plex',
    host: 'alpha',
    autoDeploy: true,
    composeContent: 'services:\n  plex:\n    image: plexinc/pms-docker',
    composeHash: 'repo-hash',
  };

  it('trust_repo redeploys ghost drift from the repo copy', async () => {
    const triggerDeploy = mock().mockResolvedValue({ deployId: 41 });

    const result = await resolveStackDriftItem({
      host: 'alpha',
      stack: 'plex',
      resolution: 'trust_repo',
      loadCurrentReport: async () => ({
        items: [{
          host: 'alpha',
          stack: 'plex',
          kind: 'ghost',
          repoComposeHash: 'repo-hash',
          latestDeployStatus: 'succeeded',
        }],
        summary: { total: 1, ghost: 1, untracked: 0, content: 0 },
        scanErrors: [],
      }),
      readRepoStack: async () => repoStack,
      readAgentCompose: async () => null,
      triggerDeploy,
      deleteTrackedStack: mock(),
      syncRepoToAgent: mock(),
    });

    expect(triggerDeploy).toHaveBeenCalledWith({
      stack: 'plex',
      host: 'alpha',
      action: 'deploy',
    });
    expect(result).toEqual({
      outcome: 'deploy-queued',
      deployId: 41,
    });
  });

  it('trust_agent removes ghost drift from the repo', async () => {
    const deleteTrackedStack = mock().mockResolvedValue({ status: 'removed', commitSha: 'abc123' });

    const result = await resolveStackDriftItem({
      host: 'alpha',
      stack: 'plex',
      resolution: 'trust_agent',
      loadCurrentReport: async () => ({
        items: [{
          host: 'alpha',
          stack: 'plex',
          kind: 'ghost',
          repoComposeHash: 'repo-hash',
          latestDeployStatus: 'succeeded',
        }],
        summary: { total: 1, ghost: 1, untracked: 0, content: 0 },
        scanErrors: [],
      }),
      readRepoStack: async () => repoStack,
      readAgentCompose: async () => null,
      triggerDeploy: mock(),
      deleteTrackedStack,
      syncRepoToAgent: mock(),
    });

    expect(deleteTrackedStack).toHaveBeenCalledWith('plex', false);
    expect(result).toEqual({
      outcome: 'repo-removed',
      commitSha: 'abc123',
    });
  });

  it('trust_agent syncs untracked drift into the repo using agent compose content', async () => {
    const syncRepoToAgent = mock().mockResolvedValue({ commitSha: 'abc123' });

    const result = await resolveStackDriftItem({
      host: 'alpha',
      stack: 'grafana',
      resolution: 'trust_agent',
      loadCurrentReport: async () => ({
        items: [{
          host: 'alpha',
          stack: 'grafana',
          kind: 'untracked',
          agentComposeHash: 'agent-hash',
          latestDeployStatus: null,
        }],
        summary: { total: 1, ghost: 0, untracked: 1, content: 0 },
        scanErrors: [],
      }),
      readRepoStack: async () => null,
      readAgentCompose: async () => ({
        stack: 'grafana',
        composeContent: 'services:\n  grafana:\n    image: grafana/grafana',
        composeHash: 'agent-hash',
      }),
      triggerDeploy: mock(),
      deleteTrackedStack: mock(),
      syncRepoToAgent,
    });

    expect(syncRepoToAgent).toHaveBeenCalledWith({
      stack: 'grafana',
      host: 'alpha',
      composeContent: 'services:\n  grafana:\n    image: grafana/grafana',
    });
    expect(result).toEqual({
      outcome: 'repo-synced',
      commitSha: 'abc123',
    });
  });

  it('remove queues teardown for untracked agent-only drift', async () => {
    const triggerDeploy = mock().mockResolvedValue({ deployId: 99 });

    const result = await resolveStackDriftItem({
      host: 'alpha',
      stack: 'grafana',
      resolution: 'remove',
      loadCurrentReport: async () => ({
        items: [{
          host: 'alpha',
          stack: 'grafana',
          kind: 'untracked',
          agentComposeHash: 'agent-hash',
          latestDeployStatus: null,
        }],
        summary: { total: 1, ghost: 0, untracked: 1, content: 0 },
        scanErrors: [],
      }),
      readRepoStack: async () => null,
      readAgentCompose: async () => null,
      triggerDeploy,
      deleteTrackedStack: mock(),
      syncRepoToAgent: mock(),
    });

    expect(triggerDeploy).toHaveBeenCalledWith({
      stack: 'grafana',
      host: 'alpha',
      action: 'teardown',
    });
    expect(result).toEqual({
      outcome: 'teardown-queued',
      deployId: 99,
    });
  });

  it('remove queues teardown for content drift when deleteTrackedStack is pending', async () => {
    const deleteTrackedStack = mock().mockResolvedValue({ status: 'teardown-pending', deployId: 77 });

    const result = await resolveStackDriftItem({
      host: 'alpha',
      stack: 'plex',
      resolution: 'remove',
      loadCurrentReport: async () => ({
        items: [{
          host: 'alpha',
          stack: 'plex',
          kind: 'content',
          repoComposeHash: 'repo-hash',
          agentComposeHash: 'agent-hash',
          latestDeployStatus: 'succeeded',
        }],
        summary: { total: 1, ghost: 0, untracked: 0, content: 1 },
        scanErrors: [],
      }),
      readRepoStack: async () => repoStack,
      readAgentCompose: async () => null,
      triggerDeploy: mock(),
      deleteTrackedStack,
      syncRepoToAgent: mock(),
    });

    expect(deleteTrackedStack).toHaveBeenCalledWith('plex', true);
    expect(result).toEqual({ outcome: 'teardown-queued', deployId: 77 });
  });

  it('remove returns repo-removed when deleteTrackedStack finishes synchronously', async () => {
    const deleteTrackedStack = mock().mockResolvedValue({ status: 'removed', commitSha: 'sha-remove' });

    const result = await resolveStackDriftItem({
      host: 'alpha',
      stack: 'plex',
      resolution: 'remove',
      loadCurrentReport: async () => ({
        items: [{
          host: 'alpha',
          stack: 'plex',
          kind: 'ghost',
          repoComposeHash: 'repo-hash',
          latestDeployStatus: 'succeeded',
        }],
        summary: { total: 1, ghost: 1, untracked: 0, content: 0 },
        scanErrors: [],
      }),
      readRepoStack: async () => repoStack,
      readAgentCompose: async () => null,
      triggerDeploy: mock(),
      deleteTrackedStack,
      syncRepoToAgent: mock(),
    });

    expect(result).toEqual({ outcome: 'repo-removed', commitSha: 'sha-remove' });
  });

  it('surfaces the underlying scan error when the target host failed during re-scan', async () => {
    await expect(resolveStackDriftItem({
      host: 'alpha',
      stack: 'plex',
      resolution: 'trust_repo',
      loadCurrentReport: async () => ({
        items: [],
        summary: { total: 0, ghost: 0, untracked: 0, content: 0 },
        scanErrors: [{ host: 'alpha', message: 'agent unreachable' }],
      }),
      readRepoStack: async () => repoStack,
      readAgentCompose: async () => null,
      triggerDeploy: mock(),
      deleteTrackedStack: mock(),
      syncRepoToAgent: mock(),
    })).rejects.toThrow('Cannot resolve drift on "alpha": agent unreachable');
  });

  it('throws when the drift item no longer exists after re-scan (TOCTOU)', async () => {
    await expect(resolveStackDriftItem({
      host: 'alpha',
      stack: 'plex',
      resolution: 'trust_repo',
      loadCurrentReport: async () => ({
        items: [],
        summary: { total: 0, ghost: 0, untracked: 0, content: 0 },
        scanErrors: [],
      }),
      readRepoStack: async () => repoStack,
      readAgentCompose: async () => null,
      triggerDeploy: mock(),
      deleteTrackedStack: mock(),
      syncRepoToAgent: mock(),
    })).rejects.toThrow('No drift item found for "alpha/plex"');
  });

  it('throws when repo copy has disappeared between scan and trust_repo resolve', async () => {
    await expect(resolveStackDriftItem({
      host: 'alpha',
      stack: 'plex',
      resolution: 'trust_repo',
      loadCurrentReport: async () => ({
        items: [{
          host: 'alpha',
          stack: 'plex',
          kind: 'ghost',
          repoComposeHash: 'repo-hash',
          latestDeployStatus: 'succeeded',
        }],
        summary: { total: 1, ghost: 1, untracked: 0, content: 0 },
        scanErrors: [],
      }),
      readRepoStack: async () => null,
      readAgentCompose: async () => null,
      triggerDeploy: mock(),
      deleteTrackedStack: mock(),
      syncRepoToAgent: mock(),
    })).rejects.toThrow('Stack "plex" is not tracked in the repo');
  });

  it('throws when agent compose has disappeared between scan and trust_agent resolve of content drift', async () => {
    await expect(resolveStackDriftItem({
      host: 'alpha',
      stack: 'plex',
      resolution: 'trust_agent',
      loadCurrentReport: async () => ({
        items: [{
          host: 'alpha',
          stack: 'plex',
          kind: 'content',
          repoComposeHash: 'repo-hash',
          agentComposeHash: 'agent-hash',
          latestDeployStatus: 'succeeded',
        }],
        summary: { total: 1, ghost: 0, untracked: 0, content: 1 },
        scanErrors: [],
      }),
      readRepoStack: async () => repoStack,
      readAgentCompose: async () => null,
      triggerDeploy: mock(),
      deleteTrackedStack: mock(),
      syncRepoToAgent: mock(),
    })).rejects.toThrow('Stack "plex" was not found on agent host "alpha"');
  });

  it('rejects trust_repo for untracked drift', async () => {
    await expect(resolveStackDriftItem({
      host: 'alpha',
      stack: 'grafana',
      resolution: 'trust_repo',
      loadCurrentReport: async () => ({
        items: [{
          host: 'alpha',
          stack: 'grafana',
          kind: 'untracked',
          agentComposeHash: 'agent-hash',
          latestDeployStatus: null,
        }],
        summary: { total: 1, ghost: 0, untracked: 1, content: 0 },
        scanErrors: [],
      }),
      readRepoStack: async () => null,
      readAgentCompose: async () => null,
      triggerDeploy: mock(),
      deleteTrackedStack: mock(),
      syncRepoToAgent: mock(),
    })).rejects.toThrow('Resolution "trust_repo" is not valid for drift kind "untracked"');
  });
});
