import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentStackInventoryEntry, AgentStackInventoryError } from '@homelab-manager/agent/types';
import type { DeployRecord } from '@/lib/deploy/types';
import type { DeployPipeline } from '@/lib/deploy/pipeline';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';
import type { StackManifest } from '@/lib/git/manifest';
import * as gitConfig from '@/lib/config/git-config';
import * as pipelineFactory from '@/lib/deploy/pipeline-factory';
import * as repoModule from '@/lib/git/repo';
import { initBareRepo, commitFiles, readFileFromRepo, FileNotFoundError } from '@/lib/git/repo';
import { parseManifest } from '@/lib/git/manifest';
import { MANIFEST, composePath, serializeManifest } from '@/lib/stacks/stack-repo-layout';
import { getTestTmpDir } from '@/lib/test/tmp-dir';

const PLEX_COMPOSE = 'services:\n  plex:\n    image: plex:repo\n';

let latestDeploys: DeployRecord[] = [];
let deployHistory: DeployRecord[] = [];
let latestDeploysError: Error | null = null;
let hasActiveDeploy = false;
let managedHosts: ManagedHost[] = [];
let inventoryByHost = new Map<string, AgentStackInventoryEntry[]>();
let inventoryErrorsByHost = new Map<string, AgentStackInventoryError[]>();
let unreachableHosts = new Set<string>();

mock.module('@/lib/clients/database-client', () => ({
  databaseConnectionManager: { getClient: () => Promise.resolve({ getPool: () => ({}) }) },
}));

mock.module('@/lib/config/database-config', () => ({ loadDatabaseConfig: () => ({}) }));

mock.module('@/lib/database/repositories/deploy-repository', () => ({
  DeployRepository: class {
    getLatestDeployPerStack = () =>
      latestDeploysError ? Promise.reject(latestDeploysError) : Promise.resolve(latestDeploys);
    getDeployHistory = (stack: string, host: string, limit: number) =>
      Promise.resolve(
        deployHistory.filter((d) => d.stack === stack && d.host === host).slice(0, limit),
      );
    hasActiveDeployForStack = () => Promise.resolve(hasActiveDeploy);
  },
}));

mock.module('@/lib/database/repositories/host-repository', () => ({
  HostRepository: class {
    findAll = () => Promise.resolve(managedHosts);
    findByName = (name: string) => Promise.resolve(managedHosts.find((h) => h.name === name) ?? null);
  },
}));

mock.module('@/lib/clients/agent-client', () => ({
  AgentClient: class {
    getStackInventory: () => Promise<{
      stacks: AgentStackInventoryEntry[];
      errors: AgentStackInventoryError[];
    }>;

    constructor(opts: { agentUrl: string }) {
      const host = managedHosts.find((h) => h.agentUrl === opts.agentUrl)?.name ?? '';
      this.getStackInventory = () =>
        unreachableHosts.has(host)
          ? Promise.reject(new Error(`agent ${host} unreachable`))
          : Promise.resolve({
              stacks: inventoryByHost.get(host) ?? [],
              errors: inventoryErrorsByHost.get(host) ?? [],
            });
    }
  },
}));

mock.module('@/lib/database/repositories/agent-keypairs-repository', () => ({
  AgentKeypairsRepository: class {
    getPrivateKeyForHost = () => Promise.resolve({ kty: 'OKP', crv: 'Ed25519', x: 'x', d: 'd' });
  },
}));

mock.module('@/lib/crypto/agent-jwt', () => ({ signAgentJwt: () => Promise.resolve('jwt') }));
mock.module('@/lib/crypto/master-key', () => ({ loadMasterKeyring: () => Promise.resolve({}) }));

function host(name: string, dockerEnabled: boolean): ManagedHost {
  return {
    id: 1,
    name,
    agentUrl: `http://${name}:3001`,
    capabilities: { docker: dockerEnabled },
    agentVersion: null,
    agentImage: null,
    agentImageTag: null,
    status: 'healthy',
    createdAt: new Date('2026-05-01T00:00:00Z'),
    updatedAt: new Date('2026-05-01T00:00:00Z'),
  };
}

function deployRecord(overrides?: Partial<DeployRecord>): DeployRecord {
  return {
    id: 1,
    stack: 'plex',
    host: 'alpha',
    commitSha: 'deadbeef',
    composeHash: 'compose-hash',
    envHash: 'env-hash',
    status: 'succeeded',
    trigger: 'ui',
    action: 'deploy',
    forceRecreate: false,
    logs: null,
    createdAt: new Date('2026-05-01T00:00:00Z'),
    postSuccess: null,
    ...overrides,
  };
}

async function hashOf(content: string): Promise<string> {
  const { computeHash } = await import('@/lib/deploy/change-detection');
  return computeHash(content);
}

describe('stack-service repo-backed operations', () => {
  let testDir: string;
  let repoPath: string;
  let loadGitConfigSpy: ReturnType<typeof spyOn>;

  /** Commit a manifest (and optional extra files) onto the bare repo, returning the new HEAD sha. */
  async function seed(
    stacks: StackManifest['stacks'],
    files: { path: string; content: string }[] = [],
  ): Promise<string> {
    return commitFiles(repoPath, () => ({
      files: [{ path: MANIFEST, content: serializeManifest({ stacks }) }, ...files],
      message: 'seed',
      author: { name: 'test', email: 'test@test.com' },
    }));
  }

  beforeEach(async () => {
    latestDeploys = [];
    deployHistory = [];
    latestDeploysError = null;
    hasActiveDeploy = false;
    managedHosts = [host('alpha', true)];
    inventoryByHost = new Map();
    inventoryErrorsByHost = new Map();
    unreachableHosts = new Set();

    testDir = mkdtempSync(join(getTestTmpDir(), 'stack-service-repo-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);

    loadGitConfigSpy = spyOn(gitConfig, 'loadGitConfig').mockReturnValue({
      reposDir: testDir,
      repoName: 'test',
      repoPath,
    });
  });

  afterEach(() => {
    loadGitConfigSpy.mockRestore();
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('getStackSummaries', () => {
    test('returns [] when the manifest does not exist', async () => {
      const { getStackSummaries } = await import('@/lib/stacks/stack-service');
      expect(await getStackSummaries()).toEqual([]);
    });

    test('marks a stack in_sync when its latest deploy is at HEAD', async () => {
      const headSha = await seed({ plex: { host: 'alpha', autoDeploy: true } });
      latestDeploys = [deployRecord({ commitSha: headSha })];

      const { getStackSummaries } = await import('@/lib/stacks/stack-service');
      const summaries = await getStackSummaries();

      expect(summaries).toHaveLength(1);
      expect(summaries[0].name).toBe('plex');
      expect(summaries[0].host).toBe('alpha');
      expect(summaries[0].deployMode).toBe('auto');
      expect(summaries[0].syncStatus).toBe('in_sync');
    });

    test('marks a stack pending when its latest deploy is behind HEAD', async () => {
      await seed({ plex: { host: 'alpha', autoDeploy: false } });
      latestDeploys = [deployRecord({ commitSha: 'an-older-sha' })];

      const { getStackSummaries } = await import('@/lib/stacks/stack-service');
      const [summary] = await getStackSummaries();
      expect(summary.syncStatus).toBe('pending');
      expect(summary.deployMode).toBe('manual');
    });

    test('falls back to unknown sync status when the deploy lookup fails', async () => {
      await seed({ plex: { host: 'alpha', autoDeploy: true } });
      latestDeploysError = new Error('connection refused');
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

      const { getStackSummaries } = await import('@/lib/stacks/stack-service');
      const [summary] = await getStackSummaries();

      expect(summary.syncStatus).toBe('unknown');
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    test('rethrows a programming error rather than reporting every stack as unknown', async () => {
      await seed({ plex: { host: 'alpha', autoDeploy: true } });
      latestDeploysError = new TypeError('undefined is not a function');

      const { getStackSummaries } = await import('@/lib/stacks/stack-service');
      await expect(getStackSummaries()).rejects.toThrow(TypeError);
    });
  });

  describe('getStackDetailByName', () => {
    test('returns the detail with compose content and parsed variable names', async () => {
      await seed({ plex: { host: 'alpha', autoDeploy: true } }, [
        { path: composePath('plex'), content: 'image: ${PLEX_IMAGE}' },
      ]);

      const { getStackDetailByName } = await import('@/lib/stacks/stack-service');
      const detail = await getStackDetailByName('plex');

      expect(detail?.name).toBe('plex');
      expect(detail?.host).toBe('alpha');
      expect(detail?.composeContent).toBe('image: ${PLEX_IMAGE}');
      expect(detail?.variableNames).toEqual(['PLEX_IMAGE']);
    });

    test('returns empty compose content when the stack has no compose file yet', async () => {
      await seed({ plex: { host: 'alpha', autoDeploy: true } });

      const { getStackDetailByName } = await import('@/lib/stacks/stack-service');
      const detail = await getStackDetailByName('plex');

      expect(detail?.composeContent).toBe('');
      expect(detail?.variableNames).toEqual([]);
    });

    test('returns null for a stack that is not in the manifest', async () => {
      await seed({ plex: { host: 'alpha', autoDeploy: true } });

      const { getStackDetailByName } = await import('@/lib/stacks/stack-service');
      expect(await getStackDetailByName('sonarr')).toBeNull();
    });

    test('returns null when reading the compose file fails for a reason other than absence', async () => {
      await seed({ plex: { host: 'alpha', autoDeploy: true } });
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
      const readSpy = spyOn(repoModule, 'readFileFromRepo').mockImplementation(
        async (_repo: string, path: string) => {
          if (path === MANIFEST) {
            return serializeManifest({ stacks: { plex: { host: 'alpha', autoDeploy: true } } });
          }
          throw new Error('object store is corrupt');
        },
      );

      const { getStackDetailByName } = await import('@/lib/stacks/stack-service');
      expect(await getStackDetailByName('plex')).toBeNull();

      readSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  describe('getStackDeployHistory', () => {
    test('returns the stack history as serializable records', async () => {
      await seed({ plex: { host: 'alpha', autoDeploy: true } });
      deployHistory = [deployRecord({ id: 7, logs: 'deploy ok' })];

      const { getStackDeployHistory } = await import('@/lib/stacks/stack-service');
      const records = await getStackDeployHistory('plex', 10);

      expect(records).toHaveLength(1);
      expect(records[0].id).toBe(7);
      expect(records[0].createdAt).toBe('2026-05-01T00:00:00.000Z');
    });

    test('returns [] for a stack that is not in the manifest', async () => {
      await seed({ plex: { host: 'alpha', autoDeploy: true } });
      deployHistory = [deployRecord()];

      const { getStackDeployHistory } = await import('@/lib/stacks/stack-service');
      expect(await getStackDeployHistory('sonarr', 10)).toEqual([]);
    });

    test('returns [] when no repo path is configured', async () => {
      loadGitConfigSpy.mockReturnValue({ reposDir: testDir, repoName: 'test', repoPath: '' });

      const { getStackDeployHistory } = await import('@/lib/stacks/stack-service');
      expect(await getStackDeployHistory('plex', 10)).toEqual([]);
    });
  });

  describe('saveStackComposeFile', () => {
    test('commits the new compose content and returns the commit sha', async () => {
      await seed({ plex: { host: 'alpha', autoDeploy: true } }, [
        { path: composePath('plex'), content: 'old' },
      ]);

      const { saveStackComposeFile } = await import('@/lib/stacks/stack-service');
      const { commitSha } = await saveStackComposeFile('plex', PLEX_COMPOSE);

      expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(await readFileFromRepo(repoPath, composePath('plex'))).toBe(PLEX_COMPOSE);
    });
  });

  describe('createStackInRepo', () => {
    test('adds the stack to the manifest with an empty compose file', async () => {
      await seed({});

      const { createStackInRepo } = await import('@/lib/stacks/stack-service');
      const { commitSha } = await createStackInRepo('plex', 'alpha', true);

      expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
      const manifest = parseManifest(await readFileFromRepo(repoPath, MANIFEST));
      expect(manifest.stacks.plex).toEqual({ host: 'alpha', autoDeploy: true });
      expect(await readFileFromRepo(repoPath, composePath('plex'))).toBe('');
    });

    test('creates the manifest when the repo has none yet', async () => {
      const { createStackInRepo } = await import('@/lib/stacks/stack-service');
      await createStackInRepo('plex', 'alpha', false);

      const manifest = parseManifest(await readFileFromRepo(repoPath, MANIFEST));
      expect(manifest.stacks.plex).toEqual({ host: 'alpha', autoDeploy: false });
    });

    test('rejects a stack name that would escape the stack directory', async () => {
      const { createStackInRepo } = await import('@/lib/stacks/stack-service');
      await expect(createStackInRepo('../etc', 'alpha', false)).rejects.toThrow(/Invalid stack name/);
    });

    test('rejects a host that is not in managed_hosts', async () => {
      const { createStackInRepo } = await import('@/lib/stacks/stack-service');
      await expect(createStackInRepo('plex', 'nowhere', false)).rejects.toThrow(
        /not found in managed_hosts/,
      );
    });

    test('rejects a stack name already in the manifest', async () => {
      await seed({ plex: { host: 'alpha', autoDeploy: true } });

      const { createStackInRepo } = await import('@/lib/stacks/stack-service');
      await expect(createStackInRepo('plex', 'alpha', false)).rejects.toThrow(/already exists/);
    });
  });

  describe('deleteStackFromRepo', () => {
    test('unmanage path removes the stack from the manifest and deletes its files', async () => {
      await seed({ plex: { host: 'alpha', autoDeploy: true } }, [
        { path: composePath('plex'), content: PLEX_COMPOSE },
      ]);

      const { deleteStackFromRepo } = await import('@/lib/stacks/stack-service');
      const result = await deleteStackFromRepo('plex', false);

      expect(result.status).toBe('removed');
      const manifest = parseManifest(await readFileFromRepo(repoPath, MANIFEST));
      expect(manifest.stacks.plex).toBeUndefined();
      await expect(readFileFromRepo(repoPath, composePath('plex'))).rejects.toBeInstanceOf(
        FileNotFoundError,
      );
    });

    test('teardown path dispatches a teardown deploy and leaves the manifest alone', async () => {
      await seed({ plex: { host: 'alpha', autoDeploy: true } }, [
        { path: composePath('plex'), content: PLEX_COMPOSE },
      ]);
      const execute = mock(() => Promise.resolve({ deployId: 99, status: 'in_progress' as const, logs: '' }));
      const pipelineSpy = spyOn(pipelineFactory, 'createDeployPipeline').mockResolvedValue({
        pipeline: { execute } as unknown as DeployPipeline,
        deployRepo: {} as never,
        stackRepoWriter: {} as never,
      });

      const { deleteStackFromRepo } = await import('@/lib/stacks/stack-service');
      const result = await deleteStackFromRepo('plex', true);

      expect(result).toEqual({ status: 'teardown-pending', deployId: 99 });
      expect(execute).toHaveBeenCalledTimes(1);
      const manifest = parseManifest(await readFileFromRepo(repoPath, MANIFEST));
      expect(manifest.stacks.plex).toBeDefined();

      pipelineSpy.mockRestore();
    });

    test('throws for a stack that is not in the manifest', async () => {
      await seed({});

      const { deleteStackFromRepo } = await import('@/lib/stacks/stack-service');
      await expect(deleteStackFromRepo('plex', false)).rejects.toThrow(/not found in manifest/);
    });

    test('throws while a deploy for the stack is still running', async () => {
      await seed({ plex: { host: 'alpha', autoDeploy: true } });
      hasActiveDeploy = true;

      const { deleteStackFromRepo } = await import('@/lib/stacks/stack-service');
      await expect(deleteStackFromRepo('plex', false)).rejects.toThrow(/active deploy in progress/);
    });
  });

  describe('getManagedHostNames', () => {
    test('returns the name of every managed host', async () => {
      managedHosts = [host('alpha', true), host('beta', false)];

      const { getManagedHostNames } = await import('@/lib/stacks/stack-service');
      expect(await getManagedHostNames()).toEqual(['alpha', 'beta']);
    });
  });

  describe('scanStackDrift', () => {
    test('reports a stack the host has but the repo does not as untracked', async () => {
      await seed({});
      inventoryByHost.set('alpha', [
        { name: 'plex', hasComposeFile: true, composeHash: await hashOf(PLEX_COMPOSE) },
      ]);

      const { scanStackDrift } = await import('@/lib/stacks/stack-service');
      const report = await scanStackDrift();

      expect(report.summary).toEqual({ total: 1, ghost: 0, untracked: 1, content: 0 });
      expect(report.items[0]).toMatchObject({ kind: 'untracked', host: 'alpha', stack: 'plex' });
      expect(report.scanErrors).toEqual([]);
    });

    test('reports a differing compose hash as content drift', async () => {
      const headSha = await seed({ plex: { host: 'alpha', autoDeploy: true } }, [
        { path: composePath('plex'), content: PLEX_COMPOSE },
      ]);
      latestDeploys = [deployRecord({ commitSha: headSha })];
      inventoryByHost.set('alpha', [
        { name: 'plex', hasComposeFile: true, composeHash: await hashOf('services: {}\n') },
      ]);

      const { scanStackDrift } = await import('@/lib/stacks/stack-service');
      const report = await scanStackDrift();

      expect(report.summary.content).toBe(1);
      expect(report.items[0]).toMatchObject({ kind: 'content', host: 'alpha', stack: 'plex' });
    });

    test('reports no drift when the host matches the repo', async () => {
      const headSha = await seed({ plex: { host: 'alpha', autoDeploy: true } }, [
        { path: composePath('plex'), content: PLEX_COMPOSE },
      ]);
      latestDeploys = [deployRecord({ commitSha: headSha })];
      inventoryByHost.set('alpha', [
        { name: 'plex', hasComposeFile: true, composeHash: await hashOf(PLEX_COMPOSE) },
      ]);

      const { scanStackDrift } = await import('@/lib/stacks/stack-service');
      const report = await scanStackDrift();

      expect(report.items).toEqual([]);
      expect(report.summary.total).toBe(0);
    });

    test('records a scan error for a repo host that is not Docker-capable', async () => {
      managedHosts = [host('alpha', true), host('beta', false)];
      await seed({
        plex: { host: 'alpha', autoDeploy: true },
        sonarr: { host: 'beta', autoDeploy: true },
      }, [
        { path: composePath('plex'), content: PLEX_COMPOSE },
        { path: composePath('sonarr'), content: 'services: {}\n' },
      ]);
      inventoryByHost.set('alpha', [
        { name: 'plex', hasComposeFile: true, composeHash: await hashOf(PLEX_COMPOSE) },
      ]);

      const { scanStackDrift } = await import('@/lib/stacks/stack-service');
      const report = await scanStackDrift();

      expect(report.scanErrors).toEqual([
        { host: 'beta', message: 'Host is not managed or is not Docker-capable; drift scan skipped.' },
      ]);
    });

    test('records a scan error for an unreachable host and still scans the others', async () => {
      managedHosts = [host('alpha', true), host('beta', true)];
      await seed({});
      unreachableHosts.add('beta');
      inventoryByHost.set('alpha', [
        { name: 'plex', hasComposeFile: true, composeHash: await hashOf(PLEX_COMPOSE) },
      ]);
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

      const { scanStackDrift } = await import('@/lib/stacks/stack-service');
      const report = await scanStackDrift();

      expect(report.scanErrors).toEqual([{ host: 'beta', message: 'agent beta unreachable' }]);
      expect(report.items).toHaveLength(1);
      errorSpy.mockRestore();
    });

    test('surfaces per-stack agent inventory errors', async () => {
      await seed({});
      inventoryErrorsByHost.set('alpha', [{ name: 'plex', message: 'permission denied' }]);

      const { scanStackDrift } = await import('@/lib/stacks/stack-service');
      const report = await scanStackDrift();

      expect(report.scanErrors).toEqual([
        { host: 'alpha', stack: 'plex', message: 'permission denied' },
      ]);
    });

    test('rethrows when the manifest read fails for a reason other than absence', async () => {
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
      const readSpy = spyOn(repoModule, 'readFileFromRepo').mockRejectedValue(
        new Error('object store is corrupt'),
      );

      const { scanStackDrift } = await import('@/lib/stacks/stack-service');
      await expect(scanStackDrift()).rejects.toThrow('object store is corrupt');

      readSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });
});
