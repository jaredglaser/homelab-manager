import { describe, test, expect, mock } from 'bun:test';
import {
  extractVariableNames,
  toStackDeployRecord,
  manifestEntryToSummary,
  manifestEntryToDetail,
  handleTriggerDeploy,
} from '@/lib/stacks/stack-mappers';
import type { DeployDeps } from '@/lib/stacks/stack-mappers';
import type { DeployRecord } from '@/lib/deploy/types';

describe('extractVariableNames', () => {
  test('extracts simple variable references', () => {
    expect(extractVariableNames('image: ${APP_IMAGE}')).toEqual(['APP_IMAGE']);
  });

  test('extracts variables with defaults', () => {
    expect(extractVariableNames('port: ${PORT:-8080}')).toEqual(['PORT']);
  });

  test('deduplicates', () => {
    expect(extractVariableNames('${VAR}\n${VAR}')).toEqual(['VAR']);
  });

  test('sorts alphabetically', () => {
    expect(extractVariableNames('${ZEBRA}\n${ALPHA}')).toEqual(['ALPHA', 'ZEBRA']);
  });

  test('returns empty for no variables', () => {
    expect(extractVariableNames('image: nginx:latest')).toEqual([]);
  });

  test('ignores $VAR without braces', () => {
    expect(extractVariableNames('$NO_BRACES')).toEqual([]);
  });

  test('handles underscore-prefixed names', () => {
    expect(extractVariableNames('${_PRIVATE}')).toEqual(['_PRIVATE']);
  });

  test('returns empty for empty string', () => {
    expect(extractVariableNames('')).toEqual([]);
  });
});

describe('toStackDeployRecord', () => {
  const record: DeployRecord = {
    id: 42,
    stack: 'plex',
    host: 'homeserver',
    commitSha: 'abc123',
    composeHash: 'hash1',
    envHash: 'hash2',
    status: 'succeeded',
    trigger: 'ui',
    action: 'deploy',
    forceRecreate: false,
    logs: 'deploy ok',
    createdAt: new Date('2026-03-01T12:00:00Z'),
  };

  test('converts Date to ISO string', () => {
    const result = toStackDeployRecord(record);
    expect(result.createdAt).toBe('2026-03-01T12:00:00.000Z');
  });

  test('preserves all fields', () => {
    const result = toStackDeployRecord(record);
    expect(result.id).toBe(42);
    expect(result.stack).toBe('plex');
    expect(result.host).toBe('homeserver');
    expect(result.commitSha).toBe('abc123');
    expect(result.envHash).toBe('hash2');
    expect(result.status).toBe('succeeded');
    expect(result.trigger).toBe('ui');
    expect(result.logs).toBe('deploy ok');
  });

  test('handles null logs', () => {
    const result = toStackDeployRecord({ ...record, logs: null });
    expect(result.logs).toBeNull();
  });
});

describe('manifestEntryToSummary', () => {
  test('maps auto deploy entry', () => {
    const result = manifestEntryToSummary('plex', { host: 'homeserver', autoDeploy: true });
    expect(result.name).toBe('plex');
    expect(result.host).toBe('homeserver');
    expect(result.deployMode).toBe('auto');
    expect(result.syncStatus).toBe('unknown');
    expect(result.lastDeployAt).toBeNull();
    expect(result.lastDeployStatus).toBeNull();
    expect(result.containerCount).toBe(0);
    expect(result.icon).toBeNull();
  });

  test('maps manual deploy entry', () => {
    const result = manifestEntryToSummary('traefik', { host: 'gateway', autoDeploy: false });
    expect(result.deployMode).toBe('manual');
  });
});

describe('manifestEntryToDetail', () => {
  test('maps entry with compose content', () => {
    const compose = 'services:\n  app:\n    image: ${APP_IMAGE}\n    ports:\n      - "${PORT:-8080}:80"';
    const result = manifestEntryToDetail('myapp', { host: 'server1', autoDeploy: false }, compose);
    expect(result.name).toBe('myapp');
    expect(result.host).toBe('server1');
    expect(result.composeContent).toBe(compose);
    expect(result.variableNames).toEqual(['APP_IMAGE', 'PORT']);
    expect(result.deployMode).toBe('manual');
  });

  test('maps entry with empty compose', () => {
    const result = manifestEntryToDetail('empty', { host: 'server1', autoDeploy: true }, '');
    expect(result.composeContent).toBe('');
    expect(result.variableNames).toEqual([]);
    expect(result.deployMode).toBe('auto');
  });
});

describe('handleTriggerDeploy', () => {
  function mockDeps(overrides?: Partial<DeployDeps>): DeployDeps {
    return {
      readCompose: mock(() => Promise.resolve('services:\n  app:\n    image: nginx')),
      getCommitSha: mock(() => Promise.resolve('abc123')),
      buildRequest: mock((input) => ({
        stack: input.stack,
        host: input.host,
        composeContent: input.composeContent,
        commitSha: input.commitSha,
        action: input.action as 'deploy',
        trigger: 'ui' as const,
        autoApproved: true,
        envContent: '',
      })),
      executePipeline: mock(() => Promise.resolve({ deployId: 42 })),
      ...overrides,
    };
  }

  test('reads compose, gets SHA, builds request, executes pipeline', async () => {
    const deps = mockDeps();
    const result = await handleTriggerDeploy(deps, { stack: 'myapp', host: 'server1', action: 'deploy' });
    expect(result.deployId).toBe(42);
    expect(deps.readCompose).toHaveBeenCalledWith('myapp');
    expect(deps.getCommitSha).toHaveBeenCalledTimes(1);
    expect(deps.buildRequest).toHaveBeenCalledTimes(1);
    expect(deps.executePipeline).toHaveBeenCalledTimes(1);
  });

  test('throws when compose missing for deploy action', async () => {
    const deps = mockDeps({
      readCompose: mock(() => Promise.reject(new Error('not found'))),
    });
    await expect(
      handleTriggerDeploy(deps, { stack: 'missing', host: 'server1', action: 'deploy' })
    ).rejects.toThrow(/No compose file found/);
  });

  test('allows missing compose for teardown action', async () => {
    const deps = mockDeps({
      readCompose: mock(() => Promise.reject(new Error('not found'))),
    });
    const result = await handleTriggerDeploy(deps, { stack: 'myapp', host: 'server1', action: 'teardown' });
    expect(result.deployId).toBe(42);
  });

  test('allows missing compose for restart action', async () => {
    const deps = mockDeps({
      readCompose: mock(() => Promise.reject(new Error('not found'))),
    });
    const result = await handleTriggerDeploy(deps, { stack: 'myapp', host: 'server1', action: 'restart' });
    expect(result.deployId).toBe(42);
  });

  test('returns 0 when pipeline returns no deployId', async () => {
    const deps = mockDeps({
      executePipeline: mock(() => Promise.resolve({})),
    });
    const result = await handleTriggerDeploy(deps, { stack: 'myapp', host: 'server1', action: 'deploy' });
    expect(result.deployId).toBe(0);
  });

  test('passes compose content and commit SHA to buildRequest', async () => {
    const deps = mockDeps({
      readCompose: mock(() => Promise.resolve('custom compose')),
      getCommitSha: mock(() => Promise.resolve('def456')),
    });
    await handleTriggerDeploy(deps, { stack: 'myapp', host: 'server1', action: 'deploy' });
    const call = (deps.buildRequest as ReturnType<typeof mock>).mock.calls[0] as [{ composeContent: string; commitSha: string }];
    expect(call[0].composeContent).toBe('custom compose');
    expect(call[0].commitSha).toBe('def456');
  });
});
