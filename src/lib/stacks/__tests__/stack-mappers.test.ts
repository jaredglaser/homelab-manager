import { describe, test, expect, mock } from 'bun:test';
import {
  computeSyncStatus,
  manifestEntryToSummary,
  manifestEntryToDetail,
  extractVariableNames,
  toStackDeployRecord,
  handleTriggerDeploy,
} from '@/lib/stacks/stack-mappers';
import type { DeployRecord } from '@/lib/deploy/types';
import type { StackEntry } from '@/lib/git/manifest';

const baseRecord: DeployRecord = {
  id: 1,
  stack: 'plex',
  host: 'homeserver',
  commitSha: 'abc123',
  composeHash: 'hash1',
  envHash: 'hash2',
  status: 'succeeded',
  trigger: 'git_push',
  action: 'deploy',
  forceRecreate: false,
  logs: null,
  createdAt: new Date('2026-01-01'),
  postSuccess: null,
};

describe('computeSyncStatus', () => {
  test('returns unknown when no deploy history', () => {
    expect(computeSyncStatus(null, 'abc123')).toBe('unknown');
  });

  test('returns unknown when no deploy history and no HEAD SHA', () => {
    expect(computeSyncStatus(null, null)).toBe('unknown');
  });

  test('returns failed when latest deploy status is failed', () => {
    const deploy: DeployRecord = { ...baseRecord, status: 'failed' };
    expect(computeSyncStatus(deploy, 'abc123')).toBe('failed');
  });

  test('returns failed when latest deploy is failed regardless of SHA match', () => {
    const deploy: DeployRecord = { ...baseRecord, status: 'failed', commitSha: 'abc123' };
    expect(computeSyncStatus(deploy, 'abc123')).toBe('failed');
  });

  test('returns in_sync when latest succeeded deploy SHA matches HEAD', () => {
    const deploy: DeployRecord = { ...baseRecord, status: 'succeeded', commitSha: 'abc123' };
    expect(computeSyncStatus(deploy, 'abc123')).toBe('in_sync');
  });

  test('returns pending when latest succeeded deploy SHA differs from HEAD', () => {
    const deploy: DeployRecord = { ...baseRecord, status: 'succeeded', commitSha: 'old-sha' };
    expect(computeSyncStatus(deploy, 'new-sha')).toBe('pending');
  });

  test('returns in_sync when latest no_change deploy SHA matches HEAD', () => {
    const deploy: DeployRecord = { ...baseRecord, status: 'no_change', commitSha: 'abc123' };
    expect(computeSyncStatus(deploy, 'abc123')).toBe('in_sync');
  });

  test('returns pending when latest no_change deploy SHA differs from HEAD', () => {
    const deploy: DeployRecord = { ...baseRecord, status: 'no_change', commitSha: 'old-sha' };
    expect(computeSyncStatus(deploy, 'new-sha')).toBe('pending');
  });

  test('returns pending for pending status (deploy not yet complete)', () => {
    const deploy: DeployRecord = { ...baseRecord, status: 'pending' };
    expect(computeSyncStatus(deploy, 'abc123')).toBe('pending');
  });

  test('returns in_progress for in_progress status (deploy not yet complete)', () => {
    const deploy: DeployRecord = { ...baseRecord, status: 'in_progress' };
    expect(computeSyncStatus(deploy, 'abc123')).toBe('in_progress');
  });

  test('returns pending when succeeded SHA matches but HEAD is null', () => {
    const deploy: DeployRecord = { ...baseRecord, status: 'succeeded', commitSha: 'abc123' };
    expect(computeSyncStatus(deploy, null)).toBe('pending');
  });
});

const baseEntry: StackEntry = {
  host: 'homeserver',
  autoDeploy: false,
};

describe('manifestEntryToSummary', () => {
  test('returns a StackSummary with correct name and host', () => {
    const result = manifestEntryToSummary('plex', baseEntry);
    expect(result.name).toBe('plex');
    expect(result.host).toBe('homeserver');
    expect(result.syncStatus).toBe('unknown');
    expect(result.deployMode).toBe('manual');
  });

  test('sets deployMode to auto when autoDeploy is true', () => {
    const result = manifestEntryToSummary('plex', { ...baseEntry, autoDeploy: true });
    expect(result.deployMode).toBe('auto');
  });
});

describe('manifestEntryToDetail', () => {
  test('returns a StackDetail with compose content and variable names', () => {
    const compose = 'services:\n  app:\n    image: nginx:${TAG}\n    env_file: ${ENV_FILE}';
    const result = manifestEntryToDetail('app', baseEntry, compose);
    expect(result.name).toBe('app');
    expect(result.composeContent).toBe(compose);
    expect(result.variableNames).toContain('TAG');
    expect(result.variableNames).toContain('ENV_FILE');
  });

  test('sets deployMode correctly', () => {
    const result = manifestEntryToDetail('app', { ...baseEntry, autoDeploy: true }, '');
    expect(result.deployMode).toBe('auto');
  });
});

describe('extractVariableNames', () => {
  test('extracts simple variable references', () => {
    expect(extractVariableNames('${FOO} and ${BAR}')).toEqual(['BAR', 'FOO']);
  });

  test('extracts variables with default syntax', () => {
    expect(extractVariableNames('${TAG:-latest}')).toEqual(['TAG']);
  });

  test('extracts variables with required syntax', () => {
    expect(extractVariableNames('${SECRET:?must be set}')).toEqual(['SECRET']);
  });

  test('extracts variables with alternative syntax', () => {
    expect(extractVariableNames('${VALUE:+override}')).toEqual(['VALUE']);
  });

  test('deduplicates repeated references', () => {
    const result = extractVariableNames('${TAG} and ${TAG}');
    expect(result).toEqual(['TAG']);
  });

  test('returns empty array when no variables present', () => {
    expect(extractVariableNames('no variables here')).toEqual([]);
  });

  test('sorts variable names alphabetically', () => {
    const result = extractVariableNames('${ZZZ} ${AAA} ${MMM}');
    expect(result).toEqual(['AAA', 'MMM', 'ZZZ']);
  });
});

describe('toStackDeployRecord', () => {
  test('maps all fields correctly and converts Date to ISO string', () => {
    const record = toStackDeployRecord(baseRecord);
    expect(record.id).toBe(1);
    expect(record.stack).toBe('plex');
    expect(record.host).toBe('homeserver');
    expect(record.commitSha).toBe('abc123');
    expect(record.status).toBe('succeeded');
    expect(typeof record.createdAt).toBe('string');
    expect(record.createdAt).toBe(new Date('2026-01-01').toISOString());
  });
});

describe('handleTriggerDeploy', () => {
  const makeDeps = (overrides = {}) => ({
    readCompose: mock(async (_stack: string) => 'services:\n  app:\n    image: nginx'),
    getCommitSha: mock(async () => 'sha-123'),
    buildRequest: mock((_input: unknown) => ({ id: 99 }) as never),
    executePipeline: mock(async (_req: unknown) => ({ deployId: 42 })),
    ...overrides,
  });

  test('returns deployId on success', async () => {
    const deps = makeDeps();
    const result = await handleTriggerDeploy(deps, { stack: 'plex', host: 'homeserver', action: 'deploy' });
    expect(result.deployId).toBe(42);
  });

  test('throws when executePipeline returns no deployId', async () => {
    const deps = makeDeps({
      executePipeline: mock(async () => ({ logs: 'already running' })),
    });
    await expect(handleTriggerDeploy(deps, { stack: 'plex', host: 'homeserver', action: 'deploy' }))
      .rejects.toThrow('Deploy could not be queued');
  });

  test('throws when readCompose fails on deploy action', async () => {
    const deps = makeDeps({
      readCompose: mock(async () => { throw new Error('not found'); }),
    });
    await expect(handleTriggerDeploy(deps, { stack: 'missing', host: 'homeserver', action: 'deploy' }))
      .rejects.toThrow('No compose file found for stack');
  });

  test('continues without compose content when readCompose fails on non-deploy action', async () => {
    const deps = makeDeps({
      readCompose: mock(async () => { throw new Error('not found'); }),
    });
    const result = await handleTriggerDeploy(deps, { stack: 'plex', host: 'homeserver', action: 'teardown' });
    expect(result.deployId).toBe(42);
  });
});
