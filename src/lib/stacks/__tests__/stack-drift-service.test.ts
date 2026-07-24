import { describe, expect, it } from 'bun:test';
import type { DeployRecord } from '@/lib/deploy/types';
import { buildStackDriftReport, getStackDriftKindLabel } from '@/lib/stacks/stack-drift-service';

const HEAD_SHA = 'sha-head';

const deploy = (overrides?: Partial<DeployRecord>): DeployRecord => ({
  id: 1,
  stack: 'plex',
  host: 'alpha',
  commitSha: HEAD_SHA,
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

const repoStack = (overrides?: Partial<{ stack: string; host: string; autoDeploy: boolean; composeHash: string }>) => ({
  stack: 'plex',
  host: 'alpha',
  autoDeploy: false,
  composeHash: 'repo-hash',
  ...overrides,
});

describe('buildStackDriftReport', () => {
  it('classifies ghost drift when a deployed repo stack is missing on the agent', () => {
    const report = buildStackDriftReport({
      repoStacks: [repoStack()],
      hosts: [{ name: 'alpha', dockerEnabled: true }],
      latestDeploys: [deploy()],
      currentHeadSha: HEAD_SHA,
      agentStacksByHost: new Map([['alpha', []]]),
      scanErrors: [],
    });

    expect(report.items).toEqual([
      {
        kind: 'ghost',
        host: 'alpha',
        stack: 'plex',
        repoComposeHash: 'repo-hash',
        latestDeployStatus: 'succeeded',
      },
    ]);
    expect(report.summary).toEqual({ total: 1, ghost: 1, untracked: 0, content: 0 });
  });

  it('does not report a never-deployed repo stack as ghost', () => {
    const report = buildStackDriftReport({
      repoStacks: [repoStack()],
      hosts: [{ name: 'alpha', dockerEnabled: true }],
      latestDeploys: [],
      currentHeadSha: HEAD_SHA,
      agentStacksByHost: new Map([['alpha', []]]),
      scanErrors: [],
    });

    expect(report.items).toEqual([]);
    expect(report.summary.total).toBe(0);
  });

  it('does not report drift for a stack whose sync status is pending', () => {
    const report = buildStackDriftReport({
      repoStacks: [repoStack()],
      hosts: [{ name: 'alpha', dockerEnabled: true }],
      latestDeploys: [deploy({ commitSha: 'sha-older' })],
      currentHeadSha: HEAD_SHA,
      agentStacksByHost: new Map([[
        'alpha',
        [{ name: 'plex', hasComposeFile: true, composeHash: 'agent-hash' }],
      ]]),
      scanErrors: [],
    });

    expect(report.items).toEqual([]);
  });

  it('does not report drift for a stack whose latest deploy is awaiting approval', () => {
    const report = buildStackDriftReport({
      repoStacks: [repoStack()],
      hosts: [{ name: 'alpha', dockerEnabled: true }],
      latestDeploys: [deploy({ status: 'pending' })],
      currentHeadSha: HEAD_SHA,
      agentStacksByHost: new Map([['alpha', []]]),
      scanErrors: [],
    });

    expect(report.items).toEqual([]);
  });

  it('does not report drift for a stack whose latest deploy failed', () => {
    const report = buildStackDriftReport({
      repoStacks: [repoStack()],
      hosts: [{ name: 'alpha', dockerEnabled: true }],
      latestDeploys: [deploy({ status: 'failed' })],
      currentHeadSha: HEAD_SHA,
      agentStacksByHost: new Map([[
        'alpha',
        [{ name: 'plex', hasComposeFile: true, composeHash: 'agent-hash' }],
      ]]),
      scanErrors: [],
    });

    expect(report.items).toEqual([]);
  });

  it('classifies content drift when a synced stack has a different hash on the agent', () => {
    const report = buildStackDriftReport({
      repoStacks: [repoStack()],
      hosts: [{ name: 'alpha', dockerEnabled: true }],
      latestDeploys: [deploy({ status: 'no_change' })],
      currentHeadSha: HEAD_SHA,
      agentStacksByHost: new Map([[
        'alpha',
        [{ name: 'plex', hasComposeFile: true, composeHash: 'agent-hash' }],
      ]]),
      scanErrors: [],
    });

    expect(report.items).toEqual([
      {
        kind: 'content',
        host: 'alpha',
        stack: 'plex',
        repoComposeHash: 'repo-hash',
        agentComposeHash: 'agent-hash',
        latestDeployStatus: 'no_change',
      },
    ]);
  });

  it('reports no drift when a synced stack matches the agent hash', () => {
    const report = buildStackDriftReport({
      repoStacks: [repoStack()],
      hosts: [{ name: 'alpha', dockerEnabled: true }],
      latestDeploys: [deploy()],
      currentHeadSha: HEAD_SHA,
      agentStacksByHost: new Map([[
        'alpha',
        [{ name: 'plex', hasComposeFile: true, composeHash: 'repo-hash' }],
      ]]),
      scanErrors: [],
    });

    expect(report.items).toEqual([]);
  });

  it('classifies untracked drift when the agent has a stack missing from the repo', () => {
    const report = buildStackDriftReport({
      repoStacks: [],
      hosts: [{ name: 'alpha', dockerEnabled: true }],
      latestDeploys: [],
      currentHeadSha: HEAD_SHA,
      agentStacksByHost: new Map([[
        'alpha',
        [{ name: 'grafana', hasComposeFile: true, composeHash: 'agent-hash' }],
      ]]),
      scanErrors: [],
    });

    expect(report.items).toEqual([
      { kind: 'untracked', host: 'alpha', stack: 'grafana', agentComposeHash: 'agent-hash' },
    ]);
    expect(report.summary).toEqual({ total: 1, ghost: 0, untracked: 1, content: 0 });
  });

  it('reports untracked drift for a never-deployed stack that is only in the manifest on another host', () => {
    const report = buildStackDriftReport({
      repoStacks: [repoStack({ stack: 'grafana', host: 'bravo' })],
      hosts: [
        { name: 'alpha', dockerEnabled: true },
        { name: 'bravo', dockerEnabled: true },
      ],
      latestDeploys: [],
      currentHeadSha: HEAD_SHA,
      agentStacksByHost: new Map([
        ['alpha', [{ name: 'grafana', hasComposeFile: true, composeHash: 'agent-hash' }]],
        ['bravo', []],
      ]),
      scanErrors: [],
    });

    expect(report.items).toEqual([
      { kind: 'untracked', host: 'alpha', stack: 'grafana', agentComposeHash: 'agent-hash' },
    ]);
  });

  it('sorts items deterministically by host, stack, then kind', () => {
    const report = buildStackDriftReport({
      repoStacks: [
        repoStack({ stack: 'plex', host: 'bravo', composeHash: 'b-plex' }),
        repoStack({ stack: 'grafana', host: 'alpha', composeHash: 'a-gr' }),
      ],
      hosts: [
        { name: 'bravo', dockerEnabled: true },
        { name: 'alpha', dockerEnabled: true },
      ],
      latestDeploys: [
        deploy({ stack: 'plex', host: 'bravo' }),
        deploy({ id: 2, stack: 'grafana', host: 'alpha' }),
      ],
      currentHeadSha: HEAD_SHA,
      agentStacksByHost: new Map([
        ['bravo', [{ name: 'sonarr', hasComposeFile: true, composeHash: 'b-sonarr' }]],
        ['alpha', [{ name: 'radarr', hasComposeFile: true, composeHash: 'a-radarr' }]],
      ]),
      scanErrors: [],
    });

    expect(report.items.map((item) => `${item.host}/${item.stack}/${item.kind}`)).toEqual([
      'alpha/grafana/ghost',
      'alpha/radarr/untracked',
      'bravo/plex/ghost',
      'bravo/sonarr/untracked',
    ]);
  });

  it('skips hosts that do not have docker capability', () => {
    const report = buildStackDriftReport({
      repoStacks: [repoStack({ host: 'noDocker' })],
      hosts: [{ name: 'noDocker', dockerEnabled: false }],
      latestDeploys: [deploy({ host: 'noDocker' })],
      currentHeadSha: HEAD_SHA,
      agentStacksByHost: new Map(),
      scanErrors: [],
    });

    expect(report.items).toEqual([]);
    expect(report.summary.total).toBe(0);
  });

  it('skips classification for hosts with scan errors and propagates the error', () => {
    const report = buildStackDriftReport({
      repoStacks: [repoStack()],
      hosts: [{ name: 'alpha', dockerEnabled: true }],
      latestDeploys: [deploy()],
      currentHeadSha: HEAD_SHA,
      agentStacksByHost: new Map(),
      scanErrors: [{ host: 'alpha', message: 'agent unreachable' }],
    });

    expect(report.items).toEqual([]);
    expect(report.scanErrors).toEqual([{ host: 'alpha', message: 'agent unreachable' }]);
  });

  it('treats a null HEAD sha as not synced', () => {
    const report = buildStackDriftReport({
      repoStacks: [repoStack()],
      hosts: [{ name: 'alpha', dockerEnabled: true }],
      latestDeploys: [deploy()],
      currentHeadSha: null,
      agentStacksByHost: new Map([['alpha', []]]),
      scanErrors: [],
    });

    expect(report.items).toEqual([]);
  });
});

describe('getStackDriftKindLabel', () => {
  it('labels every drift kind', () => {
    expect(getStackDriftKindLabel('ghost')).toBe('Ghost');
    expect(getStackDriftKindLabel('untracked')).toBe('Untracked');
    expect(getStackDriftKindLabel('content')).toBe('Content Drift');
  });
});
