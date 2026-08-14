import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import type { AiAnalysisRepository } from '@/lib/database/repositories/ai-analysis-repository';
import type { DockerContainerEventRow } from '@/lib/database/repositories/docker-container-event-repository';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';
import type { AiContainerProfile } from '@/types/ai';
import type { AiModelSet } from '@/lib/ai/provider';
import { AI_DEFAULTS } from '@/lib/ai/config';
import { Semaphore } from '@/lib/ai/semaphore';
import type { ContainerLogAnalyst } from '@/worker/ai/container-log-analyst';
import { FleetLogAnalysisManager, resolveTargets } from '@/worker/ai/fleet-log-analysis-manager';

const models: AiModelSet = {
  analyst: 'analyst' as never,
  profiler: 'profiler' as never,
  analystModelId: 'analyst-8b',
  profilerModelId: 'profiler-70b',
  maxContextTokens: 32_768,
};

function host(name: string, agentUrl = `http://${name}:9090`): ManagedHost {
  return {
    id: 1,
    name,
    agentUrl,
    capabilities: { docker: true },
    agentVersion: null,
    agentImage: null,
    agentImageTag: null,
    status: 'healthy',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function upsert(overrides: Partial<Record<string, unknown>> = {}): DockerContainerEventRow {
  return {
    at: new Date('2026-08-14T10:00:00Z'),
    host: 'nuc',
    containerId: 'abc123',
    eventType: 'upsert',
    state: 'running',
    name: 'media-plex-1',
    image: 'plex:latest',
    labels: {},
    ports: [],
    mounts: [],
    composeProject: 'media',
    serviceKey: 'media/plex',
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    ...overrides,
  } as DockerContainerEventRow;
}

function profile(overrides: Partial<AiContainerProfile> = {}): AiContainerProfile {
  return {
    host: 'nuc',
    containerKey: 'media/plex',
    enabled: true,
    status: 'ready',
    skillMarkdown: null,
    skillVersion: 0,
    sampleStartedAt: null,
    sampleEndedAt: null,
    sampleLineCount: 0,
    model: null,
    error: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('resolveTargets', () => {
  it('keys targets by compose service and attaches the host agent URL', () => {
    const targets = resolveTargets([upsert()], [host('nuc')]);
    expect(targets).toEqual([
      {
        host: 'nuc',
        containerKey: 'media/plex',
        containerId: 'abc123',
        image: 'plex:latest',
        agentUrl: 'http://nuc:9090',
      },
    ]);
  });

  it('ignores containers that are not running', () => {
    expect(resolveTargets([upsert({ state: 'exited' })], [host('nuc')])).toEqual([]);
  });

  it('ignores destroy rows', () => {
    const destroy = {
      at: new Date(),
      host: 'nuc',
      containerId: 'abc123',
      eventType: 'destroy',
    } as DockerContainerEventRow;
    expect(resolveTargets([destroy], [host('nuc')])).toEqual([]);
  });

  it('ignores containers on a host that is no longer managed', () => {
    expect(resolveTargets([upsert()], [])).toEqual([]);
  });

  it('keeps the most recent row when a redeploy leaves two containers for one service', () => {
    const targets = resolveTargets(
      [
        upsert({ containerId: 'old', at: new Date('2026-08-14T09:00:00Z') }),
        upsert({ containerId: 'new', at: new Date('2026-08-14T10:00:00Z') }),
      ],
      [host('nuc')],
    );
    expect(targets).toHaveLength(1);
    expect(targets[0].containerId).toBe('new');
  });

  it('ignores an older row that arrives after a newer one', () => {
    const targets = resolveTargets(
      [
        upsert({ containerId: 'new', at: new Date('2026-08-14T10:00:00Z') }),
        upsert({ containerId: 'old', at: new Date('2026-08-14T09:00:00Z') }),
      ],
      [host('nuc')],
    );
    expect(targets[0].containerId).toBe('new');
  });

  it('falls back to the container name outside a stack', () => {
    const targets = resolveTargets(
      [upsert({ serviceKey: null, name: 'watchtower' })],
      [host('nuc')],
    );
    expect(targets[0].containerKey).toBe('watchtower');
  });
});

interface FakeRunner {
  containerId: string;
  stopped: boolean;
  runner: ContainerLogAnalyst;
}

function fakeRunner(containerId: string): FakeRunner {
  let resolveRun: () => void = () => {};
  const running = new Promise<void>((resolve) => {
    resolveRun = resolve;
  });
  const entry: FakeRunner = {
    containerId,
    stopped: false,
    runner: {
      containerId,
      run: () => running,
      stop: () => {
        entry.stopped = true;
        resolveRun();
      },
    } as unknown as ContainerLogAnalyst,
  };
  return entry;
}

describe('FleetLogAnalysisManager', () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spyOn(console, 'info').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  function build(options: {
    snapshot?: () => Promise<DockerContainerEventRow[]>;
    hosts?: () => Promise<ManagedHost[]>;
    profiles?: AiContainerProfile[];
    getSigner?: (hostName: string) => Promise<(() => Promise<string>) | null>;
    signal?: AbortSignal;
    created?: Map<string, FakeRunner>;
    ensureProfile?: (host: string, containerKey: string) => Promise<AiContainerProfile>;
  }) {
    const created = options.created ?? new Map<string, FakeRunner>();
    const repo = {
      listProfiles: async () => options.profiles ?? [],
      ensureProfile:
        options.ensureProfile ?? (async (host: string, containerKey: string) => profile({ host, containerKey })),
    } as unknown as AiAnalysisRepository;

    const manager = new FleetLogAnalysisManager({
      repo,
      models,
      settings: AI_DEFAULTS,
      semaphore: new Semaphore(2),
      signal: options.signal ?? new AbortController().signal,
      loadSnapshot: options.snapshot ?? (async () => [upsert()]),
      loadHosts: options.hosts ?? (async () => [host('nuc')]),
      getSigner: options.getSigner ?? (async () => async () => 'jwt'),
      buildAnalyst: (target) => {
        const entry = fakeRunner(target.containerId);
        created.set(`${target.host}/${target.containerKey}`, entry);
        return entry.runner;
      },
    });

    return { manager, created };
  }

  it('starts an analyst per running container', async () => {
    const { manager, created } = build({});
    await manager.reconcile();
    expect(manager.entityIds()).toEqual(['nuc/media/plex']);
    expect(created.get('nuc/media/plex')?.containerId).toBe('abc123');
  });

  it('registers a profile row for every container it starts watching', async () => {
    const ensured: string[] = [];
    const { manager } = build({
      ensureProfile: async (host, containerKey) => {
        ensured.push(`${host}/${containerKey}`);
        return profile({ host, containerKey });
      },
    });
    await manager.reconcile();
    expect(ensured).toEqual(['nuc/media/plex']);
  });

  it('does not start an analyst for a container switched off in the UI', async () => {
    const { manager } = build({ profiles: [profile({ enabled: false })] });
    await manager.reconcile();
    expect(manager.entityIds()).toEqual([]);
  });

  it('stops an analyst once its container disappears', async () => {
    let rows = [upsert()];
    const { manager, created } = build({ snapshot: async () => rows });
    await manager.reconcile();

    rows = [];
    await manager.reconcile();

    expect(manager.entityIds()).toEqual([]);
    expect(created.get('nuc/media/plex')?.stopped).toBe(true);
  });

  it('stops an analyst once its container is switched off', async () => {
    let profiles = [profile({ enabled: true })];
    const repoProfiles = () => profiles;
    const created = new Map<string, FakeRunner>();
    const manager = new FleetLogAnalysisManager({
      repo: {
        listProfiles: async () => repoProfiles(),
        ensureProfile: async (host: string, containerKey: string) => profile({ host, containerKey }),
      } as unknown as AiAnalysisRepository,
      models,
      settings: AI_DEFAULTS,
      semaphore: new Semaphore(2),
      signal: new AbortController().signal,
      loadSnapshot: async () => [upsert()],
      loadHosts: async () => [host('nuc')],
      getSigner: async () => async () => 'jwt',
      buildAnalyst: (target) => {
        const entry = fakeRunner(target.containerId);
        created.set(`${target.host}/${target.containerKey}`, entry);
        return entry.runner;
      },
    });

    await manager.reconcile();
    profiles = [profile({ enabled: false })];
    await manager.reconcile();

    expect(manager.entityIds()).toEqual([]);
  });

  it('leaves an unchanged analyst alone across reconciles', async () => {
    let builds = 0;
    const manager = new FleetLogAnalysisManager({
      repo: {
        listProfiles: async () => [],
        ensureProfile: async (host: string, containerKey: string) => profile({ host, containerKey }),
      } as unknown as AiAnalysisRepository,
      models,
      settings: AI_DEFAULTS,
      semaphore: new Semaphore(2),
      signal: new AbortController().signal,
      loadSnapshot: async () => [upsert()],
      loadHosts: async () => [host('nuc')],
      getSigner: async () => async () => 'jwt',
      buildAnalyst: (target) => {
        builds += 1;
        return fakeRunner(target.containerId).runner;
      },
    });

    await manager.reconcile();
    await manager.reconcile();

    expect(builds).toBe(1);
    expect(manager.entityIds()).toEqual(['nuc/media/plex']);
  });

  it('logs an analyst that exits with an error instead of leaving it unhandled', async () => {
    const manager = new FleetLogAnalysisManager({
      repo: {
        listProfiles: async () => [],
        ensureProfile: async (host: string, containerKey: string) => profile({ host, containerKey }),
      } as unknown as AiAnalysisRepository,
      models,
      settings: AI_DEFAULTS,
      semaphore: new Semaphore(2),
      signal: new AbortController().signal,
      loadSnapshot: async () => [upsert()],
      loadHosts: async () => [host('nuc')],
      getSigner: async () => async () => 'jwt',
      buildAnalyst: () =>
        ({
          containerId: 'abc123',
          run: async () => {
            throw new Error('stream never opened');
          },
          stop: () => {},
        }) as unknown as ContainerLogAnalyst,
    });

    await manager.reconcile();
    await manager[Symbol.asyncDispose]();

    expect(errorSpy.mock.calls.flat().join(' ')).toContain('exited with error');
  });

  it('replaces the analyst when a redeploy changes the container id', async () => {
    let rows = [upsert({ containerId: 'old' })];
    const created = new Map<string, FakeRunner>();
    const { manager } = build({ snapshot: async () => rows, created });
    await manager.reconcile();
    const first = created.get('nuc/media/plex');

    rows = [upsert({ containerId: 'new', at: new Date('2026-08-14T11:00:00Z') })];
    await manager.reconcile();

    expect(first?.stopped).toBe(true);
    expect(created.get('nuc/media/plex')?.containerId).toBe('new');
    expect(manager.entityIds()).toEqual(['nuc/media/plex']);
  });

  it('skips a host with no enrolled keypair', async () => {
    const { manager } = build({ getSigner: async () => null });
    await manager.reconcile();
    expect(manager.entityIds()).toEqual([]);
  });

  it('skips and logs a host whose signer lookup throws', async () => {
    const { manager } = build({
      getSigner: async () => {
        throw new Error('keyring unavailable');
      },
    });
    await manager.reconcile();
    expect(manager.entityIds()).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('logs and leaves the current set alone when the inventory read fails', async () => {
    let fail = false;
    const { manager } = build({
      snapshot: async () => {
        if (fail) throw new Error('db down');
        return [upsert()];
      },
    });
    await manager.reconcile();
    fail = true;
    await manager.reconcile();

    expect(manager.entityIds()).toEqual(['nuc/media/plex']);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('does nothing once the shutdown signal has fired', async () => {
    const controller = new AbortController();
    controller.abort();
    const { manager } = build({ signal: controller.signal });
    await manager.reconcile();
    expect(manager.entityIds()).toEqual([]);
  });

  it('serialises concurrent reconciles', async () => {
    let inFlight = 0;
    let overlapped = false;
    const { manager } = build({
      snapshot: async () => {
        inFlight += 1;
        if (inFlight > 1) overlapped = true;
        await Promise.resolve();
        inFlight -= 1;
        return [upsert()];
      },
    });

    await Promise.all([manager.reconcile(), manager.reconcile(), manager.reconcile()]);
    expect(overlapped).toBe(false);
  });

  it('stops every analyst on disposal', async () => {
    const created = new Map<string, FakeRunner>();
    const { manager } = build({ created });
    await manager.reconcile();
    await manager[Symbol.asyncDispose]();

    expect(manager.entityIds()).toEqual([]);
    expect(created.get('nuc/media/plex')?.stopped).toBe(true);
  });
});
