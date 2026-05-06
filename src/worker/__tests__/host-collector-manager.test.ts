import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';
import {
  HostCollectorManager,
  type HostCollectorBundle,
  type HostCollectorFactory,
} from '../host-collector-manager';
import type { BaseCollector } from '../collectors/base-collector';

const originalConsoleInfo = console.info;
const originalConsoleError = console.error;
const originalConsoleLog = console.log;

function makeWorkerConfig(overrides?: Partial<WorkerConfig>): WorkerConfig {
  const base: WorkerConfig = {
    enabled: true,
    docker: { enabled: true },
    zfs: { enabled: true },
    proxmox: { enabled: false },
    collection: { interval: 1000 },
  } as WorkerConfig;
  return { ...base, ...(overrides ?? {}) } as WorkerConfig;
}

function makeHost(name: string, overrides?: Partial<ManagedHost>): ManagedHost {
  return {
    id: 1,
    name,
    agentUrl: `http://${name}:9090`,
    capabilities: { docker: true, zfs: false },
    agentVersion: null,
    status: 'healthy',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

interface FakeCollector extends BaseCollector {
  resolveRunner: () => void;
  rejectRunner: (err: Error) => void;
  stopped: boolean;
}

function makeFakeCollector(name: string): { collector: FakeCollector; runner: Promise<void> } {
  let resolveRunner!: () => void;
  let rejectRunner!: (err: Error) => void;
  const runner = new Promise<void>((res, rej) => {
    resolveRunner = res;
    rejectRunner = rej;
  });
  const fake = {
    name,
    stopped: false,
    resolveRunner,
    rejectRunner,
    run: () => runner,
    stop: function (this: FakeCollector) { this.stopped = true; },
    [Symbol.asyncDispose]: async function (this: FakeCollector) { this.stopped = true; },
  } as unknown as FakeCollector;
  return { collector: fake, runner };
}

interface FactoryCall {
  hostName: string;
  token: string;
  controller: AbortController;
}

function makeFactory(): { factory: HostCollectorFactory; calls: FactoryCall[]; created: FakeCollector[] } {
  const calls: FactoryCall[] = [];
  const created: FakeCollector[] = [];
  const factory: HostCollectorFactory = (host, token, controller, stack) => {
    calls.push({ hostName: host.name, token, controller });
    const { collector, runner } = makeFakeCollector(`fake-${host.name}`);
    stack.use(collector);
    created.push(collector);
    const bundle: HostCollectorBundle = {
      collectors: [collector],
      runners: [runner],
    };
    // resolve immediately when controller aborts so removeHost finishes
    controller.signal.addEventListener('abort', () => collector.resolveRunner(), { once: true });
    return bundle;
  };
  return { factory, calls, created };
}

describe('HostCollectorManager', () => {
  let controller: AbortController;

  beforeEach(() => {
    console.info = mock(() => {});
    console.error = mock(() => {});
    console.log = mock(() => {});
    controller = new AbortController();
  });

  afterEach(() => {
    console.info = originalConsoleInfo;
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
    controller.abort();
  });

  it('adds collectors for hosts present at first reconcile', async () => {
    const { factory, calls } = makeFactory();
    const hosts = [makeHost('a'), makeHost('b')];
    const getToken = mock(async (n: string) => `token-${n}`);

    const manager = new HostCollectorManager(
      makeWorkerConfig(),
      controller.signal,
      async () => hosts,
      getToken,
      factory,
    );

    await manager.reconcile();

    expect(calls.map((c) => c.hostName).sort()).toEqual(['a', 'b']);
    expect(manager.hostNames().sort()).toEqual(['a', 'b']);
    expect(manager.collectors()).toHaveLength(2);

    await manager[Symbol.asyncDispose]();
  });

  it('removes collectors for hosts that disappear', async () => {
    const { factory, created } = makeFactory();
    let hosts = [makeHost('a'), makeHost('b')];
    const manager = new HostCollectorManager(
      makeWorkerConfig(),
      controller.signal,
      async () => hosts,
      async (n) => `tok-${n}`,
      factory,
    );

    await manager.reconcile();
    expect(manager.hostNames().sort()).toEqual(['a', 'b']);

    // Drop b
    hosts = [makeHost('a')];
    await manager.reconcile();

    expect(manager.hostNames()).toEqual(['a']);
    // The fake collector for 'b' should have been disposed
    expect(created.find((c) => c.name === 'fake-b')?.stopped).toBe(true);

    await manager[Symbol.asyncDispose]();
  });

  it('recreates a host when agentUrl changes', async () => {
    const { factory, calls, created } = makeFactory();
    let hosts = [makeHost('a', { agentUrl: 'http://a:9090' })];
    const manager = new HostCollectorManager(
      makeWorkerConfig(),
      controller.signal,
      async () => hosts,
      async () => 'tok',
      factory,
    );

    await manager.reconcile();
    expect(calls).toHaveLength(1);

    // change url
    hosts = [makeHost('a', { agentUrl: 'http://a:9999' })];
    await manager.reconcile();

    // Should have created a second fake (after disposing the first)
    expect(calls).toHaveLength(2);
    expect(created[0].stopped).toBe(true);
    expect(created[1].stopped).toBe(false);

    await manager[Symbol.asyncDispose]();
  });

  it('recreates a host when capabilities change', async () => {
    const { factory, calls } = makeFactory();
    let hosts = [makeHost('a', { capabilities: { docker: true, zfs: false } })];
    const manager = new HostCollectorManager(
      makeWorkerConfig(),
      controller.signal,
      async () => hosts,
      async () => 'tok',
      factory,
    );

    await manager.reconcile();
    expect(calls).toHaveLength(1);

    hosts = [makeHost('a', { capabilities: { docker: true, zfs: true } })];
    await manager.reconcile();

    expect(calls).toHaveLength(2);

    await manager[Symbol.asyncDispose]();
  });

  it('skips hosts whose token cannot be resolved', async () => {
    const { factory, calls } = makeFactory();
    const hosts = [makeHost('a'), makeHost('b')];
    const getToken = mock(async (n: string) => (n === 'a' ? null : 'tok-b'));

    const manager = new HostCollectorManager(
      makeWorkerConfig(),
      controller.signal,
      async () => hosts,
      getToken,
      factory,
    );

    await manager.reconcile();

    expect(calls.map((c) => c.hostName)).toEqual(['b']);
    expect(manager.hostNames()).toEqual(['b']);

    await manager[Symbol.asyncDispose]();
  });

  it('logs and skips when getToken throws', async () => {
    const { factory, calls } = makeFactory();
    const hosts = [makeHost('a'), makeHost('b')];
    const getToken = mock(async (n: string) => {
      if (n === 'a') throw new Error('bao down');
      return 'tok';
    });

    const manager = new HostCollectorManager(
      makeWorkerConfig(),
      controller.signal,
      async () => hosts,
      getToken,
      factory,
    );

    await manager.reconcile();

    expect(calls.map((c) => c.hostName)).toEqual(['b']);
    expect(console.error).toHaveBeenCalled();

    await manager[Symbol.asyncDispose]();
  });

  it('logs and skips when findAllHosts throws', async () => {
    const { factory, calls } = makeFactory();
    const manager = new HostCollectorManager(
      makeWorkerConfig(),
      controller.signal,
      async () => { throw new Error('db down'); },
      async () => 'tok',
      factory,
    );

    await manager.reconcile();

    expect(calls).toHaveLength(0);
    expect(console.error).toHaveBeenCalled();

    await manager[Symbol.asyncDispose]();
  });

  it('skips hosts when no requested capability is enabled', async () => {
    const { factory, calls } = makeFactory();
    // Worker docker disabled, host has only docker capability
    const hosts = [makeHost('a', { capabilities: { docker: true, zfs: false } })];
    const manager = new HostCollectorManager(
      makeWorkerConfig({ docker: { enabled: false }, zfs: { enabled: true } } as Partial<WorkerConfig>),
      controller.signal,
      async () => hosts,
      async () => 'tok',
      factory,
    );

    await manager.reconcile();
    expect(calls).toHaveLength(0);
    expect(manager.hostNames()).toEqual([]);

    await manager[Symbol.asyncDispose]();
  });

  it('serialises concurrent reconcile calls', async () => {
    const { factory, calls } = makeFactory();
    let resolveFind!: () => void;
    const blocked = new Promise<void>((r) => { resolveFind = r; });
    const findAll = mock(async () => {
      await blocked;
      return [makeHost('a')];
    });

    const manager = new HostCollectorManager(
      makeWorkerConfig(),
      controller.signal,
      findAll as () => Promise<ManagedHost[]>,
      async () => 'tok',
      factory,
    );

    const r1 = manager.reconcile();
    const r2 = manager.reconcile();

    resolveFind();
    await Promise.all([r1, r2]);

    // Both reconciles complete, no double-add
    expect(calls).toHaveLength(1);
    expect(manager.hostNames()).toEqual(['a']);

    await manager[Symbol.asyncDispose]();
  });

  it('does not add new hosts after global abort', async () => {
    const { factory, calls } = makeFactory();
    const manager = new HostCollectorManager(
      makeWorkerConfig(),
      controller.signal,
      async () => [makeHost('a')],
      async () => 'tok',
      factory,
    );

    controller.abort();
    await manager.reconcile();

    expect(calls).toHaveLength(0);
    expect(manager.hostNames()).toEqual([]);
  });

  it('asyncDispose stops collectors for all tracked hosts', async () => {
    const { factory, created } = makeFactory();
    const manager = new HostCollectorManager(
      makeWorkerConfig(),
      controller.signal,
      async () => [makeHost('a'), makeHost('b'), makeHost('c')],
      async () => 'tok',
      factory,
    );

    await manager.reconcile();
    expect(manager.hostNames()).toHaveLength(3);

    await manager[Symbol.asyncDispose]();

    expect(manager.hostNames()).toEqual([]);
    for (const c of created) expect(c.stopped).toBe(true);
  });

  it('runners() returns promises for all active runners', async () => {
    const { factory } = makeFactory();
    const manager = new HostCollectorManager(
      makeWorkerConfig(),
      controller.signal,
      async () => [makeHost('a'), makeHost('b')],
      async (n) => `tok-${n}`,
      factory,
    );

    await manager.reconcile();
    const runners = manager.runners();
    expect(runners).toHaveLength(2);
    expect(runners.every((r) => r instanceof Promise)).toBe(true);

    await manager[Symbol.asyncDispose]();
  });

  it('logs error when a runner rejects', async () => {
    let rejectFn!: (err: Error) => void;
    const factory: HostCollectorFactory = (host, _token, controller, stack) => {
      const runner = new Promise<void>((_, rej) => { rejectFn = rej; });
      const collector = {
        name: `fake-${host.name}`,
        stopped: false,
        run: () => runner,
        stop: function () {},
        [Symbol.asyncDispose]: async function () {},
      } as unknown as BaseCollector;
      stack.use(collector);
      controller.signal.addEventListener('abort', () => rejectFn(new Error('aborted')), { once: true });
      return { collectors: [collector], runners: [runner] };
    };

    const manager = new HostCollectorManager(
      makeWorkerConfig(),
      controller.signal,
      async () => [makeHost('a')],
      async () => 'tok',
      factory,
    );

    await manager.reconcile();
    rejectFn(new Error('stream died'));
    await new Promise((r) => setTimeout(r, 0));
    expect(console.error).toHaveBeenCalled();

    await manager[Symbol.asyncDispose]();
  });

  it('detaches per-host abort listeners from globalSignal on remove', async () => {
    const { factory } = makeFactory();
    let hosts = [makeHost('a'), makeHost('b'), makeHost('c')];

    // Spy on add/removeEventListener to count net listener attachments.
    let attached = 0;
    let detached = 0;
    const realAdd = controller.signal.addEventListener.bind(controller.signal);
    const realRemove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((type: string, listener: any, opts?: any) => {
      if (type === 'abort') attached++;
      return realAdd(type, listener, opts);
    }) as any;
    controller.signal.removeEventListener = ((type: string, listener: any) => {
      if (type === 'abort') detached++;
      return realRemove(type, listener);
    }) as any;

    const manager = new HostCollectorManager(
      makeWorkerConfig(),
      controller.signal,
      async () => hosts,
      async () => 'tok',
      factory,
    );

    await manager.reconcile();
    expect(attached).toBe(3);

    // Drop b and c — each remove should detach its abort listener.
    hosts = [makeHost('a')];
    await manager.reconcile();

    expect(detached).toBe(2);
    expect(manager.hostNames()).toEqual(['a']);

    await manager[Symbol.asyncDispose]();
    // 'a' detaches on dispose
    expect(detached).toBe(3);
  });
});
