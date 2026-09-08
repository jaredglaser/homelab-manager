import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentStackInventoryEntry, AgentStackInventoryError } from '@homelab-manager/agent/types';
import type { DeployRecord, DeployRequest } from '@/lib/deploy/types';
import type { DeployPipeline } from '@/lib/deploy/pipeline';
import * as gitConfig from '@/lib/config/git-config';
import * as pipelineFactory from '@/lib/deploy/pipeline-factory';
import * as repoModule from '@/lib/git/repo';
import { initBareRepo, commitFiles, listFilesInRepo, readFileFromRepo } from '@/lib/git/repo';
import { MANIFEST, composePath } from '@/lib/stacks/stack-repo-layout';
import { getTestTmpDir } from '@/lib/test/tmp-dir';

const AGENT_COMPOSE = 'services:\n  plex:\n    image: plex:host-only\n';
const REPO_COMPOSE = 'services:\n  plex:\n    image: plex:repo\n';

/** Ordered log of every side effect the resolution reaches, so ordering assertions do not depend on mock call counts alone. */
let events: string[] = [];
let inventory: AgentStackInventoryEntry[] = [];
let inventoryErrors: AgentStackInventoryError[] = [];
let composeResponse: () => Promise<{ stack: string; composeContent: string; composeHash: string }>;
let teardownResponse: () => Promise<{ success: boolean; logs: string }>;
let latestDeploys: DeployRecord[] = [];
let agentConstructions = 0;
let privateKeyDecrypts = 0;

mock.module('@/lib/clients/database-client', () => ({
  databaseConnectionManager: { getClient: () => Promise.resolve({ getPool: () => ({}) }) },
}));

mock.module('@/lib/config/database-config', () => ({
  loadDatabaseConfig: () => ({}),
}));

mock.module('@/lib/database/repositories/deploy-repository', () => ({
  DeployRepository: class {
    getLatestDeployPerStack = () => Promise.resolve(latestDeploys);
  },
}));

const MANAGED_HOSTS = [
  { name: 'alpha', agentUrl: 'http://alpha:3001', capabilities: { docker: true } },
  { name: 'gamma', agentUrl: 'http://gamma:3001', capabilities: { docker: false } },
];

mock.module('@/lib/database/repositories/host-repository', () => ({
  HostRepository: class {
    findAll = () => Promise.resolve(MANAGED_HOSTS);
    findByName = (name: string) => Promise.resolve(MANAGED_HOSTS.find((host) => host.name === name) ?? null);
  },
}));

mock.module('@/lib/clients/agent-client', () => ({
  AgentClient: class {
    constructor() {
      agentConstructions++;
    }
    getStackInventory = () => {
      events.push('inventory');
      return Promise.resolve({ stacks: inventory, errors: inventoryErrors });
    };
    getStackCompose = () => {
      events.push('compose');
      return composeResponse();
    };
    teardown = () => {
      events.push('teardown');
      return teardownResponse();
    };
  },
}));

mock.module('@/lib/database/repositories/agent-keypairs-repository', () => ({
  AgentKeypairsRepository: class {
    getPrivateKeyForHost = () => {
      privateKeyDecrypts++;
      return Promise.resolve({ kty: 'OKP', crv: 'Ed25519', x: 'x', d: 'd' });
    };
  },
}));

mock.module('@/lib/crypto/agent-jwt', () => ({ signAgentJwt: () => Promise.resolve('jwt') }));
mock.module('@/lib/crypto/master-key', () => ({ loadMasterKeyring: () => Promise.resolve({}) }));

function deployRecord(commitSha: string, overrides?: Partial<DeployRecord>): DeployRecord {
  return {
    id: 1,
    stack: 'plex',
    host: 'alpha',
    commitSha,
    composeHash: 'compose-hash',
    envHash: 'env-hash',
    status: 'succeeded',
    trigger: 'ui',
    action: 'deploy',
    forceRecreate: false,
    logs: null,
    createdAt: new Date('2026-05-01T00:00:00Z'),
    startedAt: null,
    postSuccess: null,
    ...overrides,
  };
}

/** sha256 of the compose the fake agent serves, so inventory hashes can agree or disagree with the repo on purpose. */
async function hashOf(content: string): Promise<string> {
  const { computeHash } = await import('@/lib/deploy/change-detection');
  return computeHash(content);
}

describe('resolveStackDriftItem', () => {
  let testDir: string;
  let repoPath: string;
  let headSha: string;
  let loadGitConfigSpy: ReturnType<typeof spyOn>;
  let createDeployPipelineSpy: ReturnType<typeof spyOn>;
  let executeMock: ReturnType<typeof mock>;

  beforeEach(async () => {
    events = [];
    inventory = [];
    inventoryErrors = [];
    latestDeploys = [];
    agentConstructions = 0;
    privateKeyDecrypts = 0;
    composeResponse = () =>
      Promise.resolve({ stack: 'plex', composeContent: AGENT_COMPOSE, composeHash: 'agent-hash' });
    teardownResponse = () => Promise.resolve({ success: true, logs: 'down' });

    testDir = mkdtempSync(join(getTestTmpDir(), 'drift-resolve-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
    headSha = await commitFiles(repoPath, () => ({
      files: [
        { path: MANIFEST, content: 'stacks:\n  plex:\n    host: alpha\n    autoDeploy: false\n' },
        { path: composePath('plex'), content: REPO_COMPOSE },
      ],
      message: 'seed',
      author: { name: 'test', email: 'test@test.com' },
    }));

    loadGitConfigSpy = spyOn(gitConfig, 'loadGitConfig').mockReturnValue({
      reposDir: testDir,
      repoName: 'test',
      repoPath,
    });

    executeMock = mock((request: DeployRequest) => {
      events.push('deploy');
      return Promise.resolve({ deployId: 42, status: 'succeeded' as const, logs: `deployed ${request.stack}` });
    });
    createDeployPipelineSpy = spyOn(pipelineFactory, 'createDeployPipeline').mockResolvedValue({
      pipeline: { execute: (request: DeployRequest) => executeMock(request) } as unknown as DeployPipeline,
      deployRepo: {} as never,
      stackRepoWriter: {} as never,
    });
  });

  afterEach(() => {
    loadGitConfigSpy.mockRestore();
    createDeployPipelineSpy.mockRestore();
    rmSync(testDir, { recursive: true, force: true });
  });

  async function recoveryFiles(): Promise<string[]> {
    return (await listFilesInRepo(repoPath)).filter((path) => path.startsWith('.drift-recovery/'));
  }

  describe('ghost drift', () => {
    beforeEach(() => {
      latestDeploys = [deployRecord(headSha)];
      inventory = [];
    });

    test('trust_repo deploys the repo version and archives nothing', async () => {
      const { resolveStackDriftItem } = await import('@/lib/stacks/stack-service');
      const result = await resolveStackDriftItem({ host: 'alpha', stack: 'plex', kind: 'ghost', resolution: 'trust_repo' });

      expect(events).toEqual(['inventory', 'deploy']);
      expect(result).toEqual({
        host: 'alpha',
        stack: 'plex',
        kind: 'ghost',
        resolution: 'trust_repo',
        recoveryCommitSha: null,
        commitSha: null,
        deployId: 42,
        deployStatus: 'succeeded',
      });
      const [request] = executeMock.mock.calls[0] as [DeployRequest];
      expect(request.action).toBe('deploy');
      expect(request).toMatchObject({ composeContent: REPO_COMPOSE, host: 'alpha' });
      expect(await recoveryFiles()).toEqual([]);
    });

    test('trust_agent drops the stack from the repo without touching the host', async () => {
      const { resolveStackDriftItem } = await import('@/lib/stacks/stack-service');
      const result = await resolveStackDriftItem({ host: 'alpha', stack: 'plex', kind: 'ghost', resolution: 'trust_agent' });

      expect(events).toEqual(['inventory']);
      expect(result.commitSha).toBeString();
      expect(result.deployId).toBeNull();
      expect(await readFileFromRepo(repoPath, MANIFEST)).not.toContain('plex');
      expect(await listFilesInRepo(repoPath)).not.toContain(composePath('plex'));
    });

    test('rejects the remove resolution', async () => {
      const { resolveStackDriftItem } = await import('@/lib/stacks/stack-service');
      await expect(
        resolveStackDriftItem({ host: 'alpha', stack: 'plex', kind: 'ghost', resolution: 'remove' }),
      ).rejects.toThrow(/does not apply to ghost drift/);
      expect(events).toEqual(['inventory']);
    });

    test('builds one agent client and decrypts the host key once', async () => {
      const { resolveStackDriftItem } = await import('@/lib/stacks/stack-service');
      await resolveStackDriftItem({ host: 'alpha', stack: 'plex', kind: 'ghost', resolution: 'trust_repo' });

      expect(agentConstructions).toBe(1);
      expect(privateKeyDecrypts).toBe(1);
      expect(events.filter((event) => event === 'inventory')).toHaveLength(1);
    });
  });

  describe('untracked drift', () => {
    beforeEach(async () => {
      inventory = [{ name: 'grafana', hasComposeFile: true, composeHash: await hashOf(AGENT_COMPOSE) }];
      composeResponse = () =>
        Promise.resolve({ stack: 'grafana', composeContent: AGENT_COMPOSE, composeHash: 'agent-hash' });
    });

    test('trust_agent adopts the host compose into the repo', async () => {
      const { resolveStackDriftItem } = await import('@/lib/stacks/stack-service');
      const result = await resolveStackDriftItem({
        host: 'alpha', stack: 'grafana', kind: 'untracked', resolution: 'trust_agent',
      });

      expect(events).toEqual(['inventory', 'compose']);
      expect(result.commitSha).toBeString();
      expect(result.recoveryCommitSha).toBeNull();
      expect(await readFileFromRepo(repoPath, composePath('grafana'))).toBe(AGENT_COMPOSE);
      expect(await readFileFromRepo(repoPath, MANIFEST)).toContain('grafana');
      expect(await recoveryFiles()).toEqual([]);
    });

    test('remove archives the host compose before tearing the stack down', async () => {
      const { resolveStackDriftItem } = await import('@/lib/stacks/stack-service');
      const result = await resolveStackDriftItem({
        host: 'alpha', stack: 'grafana', kind: 'untracked', resolution: 'remove',
      });

      expect(events).toEqual(['inventory', 'compose', 'teardown']);
      expect(result.recoveryCommitSha).toBeString();

      const archived = await recoveryFiles();
      expect(archived).toHaveLength(1);
      expect(archived[0]).toStartWith('.drift-recovery/alpha/grafana/');
      expect(await readFileFromRepo(repoPath, archived[0])).toBe(AGENT_COMPOSE);
    });

    test('trust_repo takes the same teardown path as remove', async () => {
      const { resolveStackDriftItem } = await import('@/lib/stacks/stack-service');
      await resolveStackDriftItem({ host: 'alpha', stack: 'grafana', kind: 'untracked', resolution: 'trust_repo' });

      expect(events).toEqual(['inventory', 'compose', 'teardown']);
      expect(await recoveryFiles()).toHaveLength(1);
    });

    test('a failed compose read aborts before teardown', async () => {
      composeResponse = () => Promise.reject(new Error('agent refused'));
      const { resolveStackDriftItem } = await import('@/lib/stacks/stack-service');

      await expect(
        resolveStackDriftItem({ host: 'alpha', stack: 'grafana', kind: 'untracked', resolution: 'remove' }),
      ).rejects.toThrow(/Could not archive the host copy of "alpha\/grafana"/);

      expect(events).toEqual(['inventory', 'compose']);
      expect(await recoveryFiles()).toEqual([]);
    });

    test('a failed archive commit aborts before teardown', async () => {
      const commitSpy = spyOn(repoModule, 'commitFiles').mockRejectedValue(new Error('object store is read-only'));
      const { resolveStackDriftItem } = await import('@/lib/stacks/stack-service');

      try {
        await expect(
          resolveStackDriftItem({ host: 'alpha', stack: 'grafana', kind: 'untracked', resolution: 'remove' }),
        ).rejects.toThrow(/aborted and the host was left untouched/);
      } finally {
        commitSpy.mockRestore();
      }

      expect(events).toEqual(['inventory', 'compose']);
    });

    test('an empty host compose aborts before teardown and archives nothing', async () => {
      composeResponse = () =>
        Promise.resolve({ stack: 'grafana', composeContent: '  \n\t', composeHash: 'agent-hash' });
      const { resolveStackDriftItem } = await import('@/lib/stacks/stack-service');

      await expect(
        resolveStackDriftItem({ host: 'alpha', stack: 'grafana', kind: 'untracked', resolution: 'remove' }),
      ).rejects.toThrow(/aborted and the host was left untouched\. The agent returned an empty compose file/);

      expect(events).toEqual(['inventory', 'compose']);
      expect(await recoveryFiles()).toEqual([]);
    });

    test('a failed teardown surfaces the agent logs and keeps the archive', async () => {
      teardownResponse = () => Promise.resolve({ success: false, logs: 'network in use' });
      const { resolveStackDriftItem } = await import('@/lib/stacks/stack-service');

      await expect(
        resolveStackDriftItem({ host: 'alpha', stack: 'grafana', kind: 'untracked', resolution: 'remove' }),
      ).rejects.toThrow(/network in use/);

      expect(await recoveryFiles()).toHaveLength(1);
    });

    test('a failed teardown names the recovery commit and says the host may be partly torn down', async () => {
      teardownResponse = () => Promise.resolve({ success: false, logs: 'network in use' });
      const { resolveStackDriftItem } = await import('@/lib/stacks/stack-service');

      await expect(
        resolveStackDriftItem({ host: 'alpha', stack: 'grafana', kind: 'untracked', resolution: 'remove' }),
      ).rejects.toThrow(
        /the host may be partly torn down, and re-running this resolution is safe\. The host copy is archived in [0-9a-f]{7}\./,
      );
    });
  });

  describe('content drift', () => {
    beforeEach(async () => {
      latestDeploys = [deployRecord(headSha)];
      inventory = [{ name: 'plex', hasComposeFile: true, composeHash: await hashOf(AGENT_COMPOSE) }];
    });

    test('trust_repo archives the host version before redeploying the repo version', async () => {
      const { resolveStackDriftItem } = await import('@/lib/stacks/stack-service');
      const result = await resolveStackDriftItem({
        host: 'alpha', stack: 'plex', kind: 'content', resolution: 'trust_repo',
      });

      expect(events).toEqual(['inventory', 'compose', 'deploy']);
      expect(result.recoveryCommitSha).toBeString();
      expect(result.deployId).toBe(42);

      const archived = await recoveryFiles();
      expect(archived).toHaveLength(1);
      expect(await readFileFromRepo(repoPath, archived[0])).toBe(AGENT_COMPOSE);

      const [request] = executeMock.mock.calls[0] as [DeployRequest];
      expect(request).toMatchObject({ composeContent: REPO_COMPOSE, forceRecreate: true });
    });

    test('a redeploy that never starts names the recovery commit and warns the compose may be gone', async () => {
      executeMock = mock(() => {
        events.push('deploy');
        return Promise.reject(new Error('pipeline unavailable'));
      });
      const { resolveStackDriftItem } = await import('@/lib/stacks/stack-service');

      await expect(
        resolveStackDriftItem({ host: 'alpha', stack: 'plex', kind: 'content', resolution: 'trust_repo' }),
      ).rejects.toThrow(
        /Could not start the redeploy of "alpha\/plex"; the host compose file may already be overwritten, and re-running this resolution is safe\. The host copy is archived in [0-9a-f]{7}\. pipeline unavailable/,
      );

      expect(events).toEqual(['inventory', 'compose', 'deploy']);
      expect(await recoveryFiles()).toHaveLength(1);
    });

    test('trust_agent adopts the host version over the repo version without an archive', async () => {
      const { resolveStackDriftItem } = await import('@/lib/stacks/stack-service');
      const result = await resolveStackDriftItem({
        host: 'alpha', stack: 'plex', kind: 'content', resolution: 'trust_agent',
      });

      expect(events).toEqual(['inventory', 'compose']);
      expect(result.recoveryCommitSha).toBeNull();
      expect(await readFileFromRepo(repoPath, composePath('plex'))).toBe(AGENT_COMPOSE);
      expect(await readFileFromRepo(repoPath, composePath('plex'), headSha)).toBe(REPO_COMPOSE);
      expect(await recoveryFiles()).toEqual([]);
    });
  });

  describe('re-scan guard', () => {
    test('refuses when the stack is no longer drifted', async () => {
      latestDeploys = [deployRecord(headSha)];
      inventory = [{ name: 'plex', hasComposeFile: true, composeHash: await hashOf(REPO_COMPOSE) }];

      const { resolveStackDriftItem } = await import('@/lib/stacks/stack-service');
      await expect(
        resolveStackDriftItem({ host: 'alpha', stack: 'plex', kind: 'ghost', resolution: 'trust_repo' }),
      ).rejects.toThrow(/no longer drifted/);
      expect(events).toEqual(['inventory']);
    });

    test('refuses when the drift kind changed since the scan', async () => {
      latestDeploys = [deployRecord(headSha)];
      inventory = [{ name: 'plex', hasComposeFile: true, composeHash: await hashOf(AGENT_COMPOSE) }];

      const { resolveStackDriftItem } = await import('@/lib/stacks/stack-service');
      await expect(
        resolveStackDriftItem({ host: 'alpha', stack: 'plex', kind: 'ghost', resolution: 'trust_agent' }),
      ).rejects.toThrow(/drift changed from ghost to content/);
      expect(await readFileFromRepo(repoPath, MANIFEST)).toContain('plex');
    });

    test('refuses when the deploy history no longer reports the stack in sync', async () => {
      latestDeploys = [deployRecord(headSha, { status: 'failed' })];
      inventory = [];

      const { resolveStackDriftItem } = await import('@/lib/stacks/stack-service');
      await expect(
        resolveStackDriftItem({ host: 'alpha', stack: 'plex', kind: 'ghost', resolution: 'trust_agent' }),
      ).rejects.toThrow(/no longer drifted/);
    });

    test('refuses when the agent could not read the target stack', async () => {
      latestDeploys = [deployRecord(headSha)];
      inventory = [];
      inventoryErrors = [{ name: 'plex', message: 'EACCES: permission denied' }];

      const { resolveStackDriftItem } = await import('@/lib/stacks/stack-service');
      await expect(
        resolveStackDriftItem({ host: 'alpha', stack: 'plex', kind: 'ghost', resolution: 'trust_agent' }),
      ).rejects.toThrow(/could not read "alpha\/plex": EACCES/);
      expect(events).toEqual(['inventory']);
      expect(await readFileFromRepo(repoPath, MANIFEST)).toContain('plex');
    });
  });

  test('surfaces an unreachable agent and changes nothing', async () => {
    inventory = [];
    const { resolveStackDriftItem } = await import('@/lib/stacks/stack-service');
    const failing = mock(() => Promise.reject(new Error('connect ECONNREFUSED')));
    mock.module('@/lib/clients/agent-client', () => ({
      AgentClient: class {
        getStackInventory = failing;
      },
    }));

    try {
      await expect(
        resolveStackDriftItem({ host: 'alpha', stack: 'plex', kind: 'ghost', resolution: 'trust_repo' }),
      ).rejects.toThrow(/ECONNREFUSED/);
      expect(executeMock).not.toHaveBeenCalled();
      expect(await listFilesInRepo(repoPath)).toEqual([MANIFEST, composePath('plex')]);
    } finally {
      mock.module('@/lib/clients/agent-client', () => ({
        AgentClient: class {
          getStackInventory = () => { events.push('inventory'); return Promise.resolve({ stacks: inventory, errors: inventoryErrors }); };
          getStackCompose = () => { events.push('compose'); return composeResponse(); };
          teardown = () => { events.push('teardown'); return teardownResponse(); };
        },
      }));
    }
  });

  test('rejects a stack name that is not a safe path segment', async () => {
    const { resolveStackDriftItem } = await import('@/lib/stacks/stack-service');
    await expect(
      resolveStackDriftItem({ host: 'alpha', stack: '../etc', kind: 'ghost', resolution: 'trust_agent' }),
    ).rejects.toThrow(/Invalid stack name/);
    expect(events).toEqual([]);
  });

  test('rejects a host that is not managed', async () => {
    const { resolveStackDriftItem } = await import('@/lib/stacks/stack-service');
    await expect(
      resolveStackDriftItem({ host: 'beta', stack: 'plex', kind: 'ghost', resolution: 'trust_agent' }),
    ).rejects.toThrow(/not found in managed_hosts/);
  });

  test('rejects a managed host that is not Docker-capable', async () => {
    const { resolveStackDriftItem } = await import('@/lib/stacks/stack-service');
    await expect(
      resolveStackDriftItem({ host: 'gamma', stack: 'plex', kind: 'ghost', resolution: 'trust_agent' }),
    ).rejects.toThrow(/not a Docker-capable managed host/);
  });
});
