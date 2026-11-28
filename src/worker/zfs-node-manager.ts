import { createHash } from 'node:crypto';
import type { ZfsNodeConnection } from '@/lib/database/repositories/zfs-node-repository';
import type { BaseCollector } from '@/worker/collectors/base-collector';

export type ZfsNodeCollectorFactory = (node: ZfsNodeConnection, controller: AbortController) => BaseCollector;

/** A runner stuck in a database call that has no statement timeout must not hold up adding or removing other nodes. */
export const ZFS_NODE_STOP_WAIT_MS = 5000;

interface Entry {
  controller: AbortController;
  collector: BaseCollector;
  runner: Promise<void>;
  identity: string;
  onGlobalAbort: () => void;
}

/** A re-encrypted key (master key rotation) decrypts to the same text, so it keeps the running session. */
function identityFor(node: ZfsNodeConnection): string {
  const keyHash = createHash('sha256').update(node.privateKey).digest('hex');
  return JSON.stringify([node.name, node.address, node.port, node.username, node.hostKeyFingerprint, keyHash]);
}

export class ZfsNodeManager implements AsyncDisposable {
  private readonly entries = new Map<number, Entry>();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly globalSignal: AbortSignal,
    private readonly listNodes: () => Promise<ZfsNodeConnection[]>,
    private readonly createCollector: ZfsNodeCollectorFactory,
    private readonly stopWaitMs = ZFS_NODE_STOP_WAIT_MS,
  ) {}

  collectors(): BaseCollector[] {
    return [...this.entries.values()].map((entry) => entry.collector);
  }

  runners(): Promise<void>[] {
    return [...this.entries.values()].map((entry) => entry.runner);
  }

  nodeNames(): string[] {
    return [...this.entries.values()].map((entry) => entry.collector.name);
  }

  /** `changedName` is the node a user just confirmed or checked: its collector retries now instead of after its backoff. */
  reconcile(changedName?: string): Promise<void> {
    const next = this.chain.then(() => this.reconcileOnce(changedName));
    this.chain = next.catch(() => {});
    return next;
  }

  private async reconcileOnce(changedName: string | undefined): Promise<void> {
    if (this.globalSignal.aborted) return;
    let desired: ZfsNodeConnection[];
    try {
      desired = await this.listNodes();
    } catch (err) {
      console.error('[ZfsNodeManager] listing ZFS nodes failed:', err instanceof Error ? err.message : err);
      return;
    }
    const byId = new Map(desired.map((node) => [node.id, node]));
    for (const [id, entry] of [...this.entries]) {
      const node = byId.get(id);
      if (!node || identityFor(node) !== entry.identity) await this.remove(id);
    }
    for (const node of desired) {
      const entry = this.entries.get(node.id);
      if (!entry) this.add(node);
      else if (node.name === changedName) entry.collector.wake();
    }
  }

  private add(node: ZfsNodeConnection): void {
    if (this.globalSignal.aborted) return;
    const controller = new AbortController();
    const onGlobalAbort = () => controller.abort();
    this.globalSignal.addEventListener('abort', onGlobalAbort, { once: true });
    const collector = this.createCollector(node, controller);
    const runner = collector.run().catch((err) => {
      console.error(`[ZfsNodeManager] collector for ${node.name} exited with error:`, err instanceof Error ? err.message : err);
    });
    console.info(`[ZfsNodeManager] started collection for ${node.name}`);
    this.entries.set(node.id, { controller, collector, runner, identity: identityFor(node), onGlobalAbort });
  }

  private async remove(id: number): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    console.info(`[ZfsNodeManager] stopping ${entry.collector.name}`);
    this.globalSignal.removeEventListener('abort', entry.onGlobalAbort);
    entry.controller.abort(new DOMException('ZFS node removed', 'AbortError'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stuck = new Promise<'stuck'>((resolve) => {
      timer = setTimeout(() => resolve('stuck'), this.stopWaitMs);
    });
    const outcome = await Promise.race([entry.runner.then(() => 'stopped' as const), stuck]);
    clearTimeout(timer);
    if (outcome === 'stuck') console.error(`[ZfsNodeManager] ${entry.collector.name} did not stop within ${this.stopWaitMs}ms, moving on`);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.remove(id)));
  }
}
