import type { AiAnalysisRepository } from '@/lib/database/repositories/ai-analysis-repository';
import type { AiContainerProfile } from '@/types/ai';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';
import type { DockerContainerEventRow } from '@/lib/database/repositories/docker-container-event-repository';
import { resolveContainerKey } from '@/lib/ai/container-key';
import type { AiRuntimeSettings } from '@/lib/ai/config';
import type { AiModelSet } from '@/lib/ai/provider';
import type { Semaphore } from '@/lib/ai/semaphore';
import { ContainerLogAnalyst } from '@/worker/ai/container-log-analyst';

export interface FleetAnalysisTarget {
  host: string;
  containerKey: string;
  containerId: string;
  image: string | null;
  agentUrl: string;
}

/**
 * Reduces the container inventory to one analysis target per stable container
 * key. When a redeploy leaves the old and new container both in the snapshot,
 * the most recently updated row wins so the analyst follows the live one.
 */
export function resolveTargets(
  snapshot: DockerContainerEventRow[],
  hosts: ManagedHost[],
): FleetAnalysisTarget[] {
  const agentUrlByHost = new Map(hosts.map((host) => [host.name, host.agentUrl]));
  const byEntity = new Map<string, { target: FleetAnalysisTarget; at: number }>();

  for (const row of snapshot) {
    if (row.eventType !== 'upsert' || row.state !== 'running') continue;
    const agentUrl = agentUrlByHost.get(row.host);
    if (!agentUrl) continue;

    const containerKey = resolveContainerKey({ name: row.name, serviceKey: row.serviceKey });
    const entityId = `${row.host}/${containerKey}`;
    const at = row.at.getTime();
    const existing = byEntity.get(entityId);
    if (existing && existing.at >= at) continue;

    byEntity.set(entityId, {
      at,
      target: {
        host: row.host,
        containerKey,
        containerId: row.containerId,
        image: row.image,
        agentUrl,
      },
    });
  }

  return [...byEntity.values()].map((entry) => entry.target);
}

export interface FleetLogAnalysisManagerDeps {
  repo: AiAnalysisRepository;
  models: AiModelSet;
  settings: AiRuntimeSettings;
  loadSnapshot: () => Promise<DockerContainerEventRow[]>;
  loadHosts: () => Promise<ManagedHost[]>;
  getSigner: (hostName: string) => Promise<(() => Promise<string>) | null>;
  signal: AbortSignal;
  /** Shared with the triage loop so the whole fleet respects one concurrency ceiling. */
  semaphore: Semaphore;
  /** Injected so tests can substitute a runner that never opens a socket. */
  buildAnalyst?: (
    target: FleetAnalysisTarget,
    signer: () => Promise<string>,
    semaphore: Semaphore,
  ) => ContainerLogAnalyst;
}

interface RunnerEntry {
  runner: ContainerLogAnalyst;
  running: Promise<void>;
}

/**
 * Owns the per-container analyst set. Reconciles it against the live container
 * inventory: a container that appears gets an analyst (and, on first sight, a
 * profiling pass) and a container that disappears or is switched off in the UI
 * loses its analyst.
 */
export class FleetLogAnalysisManager implements AsyncDisposable {
  private readonly entries = new Map<string, RunnerEntry>();
  private reconcileChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: FleetLogAnalysisManagerDeps) {}

  entityIds(): string[] {
    return [...this.entries.keys()];
  }

  reconcile(): Promise<void> {
    const next = this.reconcileChain.then(() => this.reconcileOnce());
    this.reconcileChain = next.catch(() => {});
    return next;
  }

  private async reconcileOnce(): Promise<void> {
    if (this.deps.signal.aborted) return;

    let targets: FleetAnalysisTarget[];
    let profiles: AiContainerProfile[];
    try {
      const [snapshot, hosts] = await Promise.all([this.deps.loadSnapshot(), this.deps.loadHosts()]);
      targets = resolveTargets(snapshot, hosts);
      profiles = await this.deps.repo.listProfiles();
    } catch (err) {
      console.error(
        '[FleetLogAnalysis] Reconcile failed to load inventory:',
        err instanceof Error ? err.message : err,
      );
      return;
    }

    const disabled = new Set(
      profiles.filter((profile) => !profile.enabled).map((profile) => `${profile.host}/${profile.containerKey}`),
    );
    const wanted = new Map<string, FleetAnalysisTarget>(
      targets
        .map((target) => [`${target.host}/${target.containerKey}`, target] as const)
        .filter(([entityId]) => !disabled.has(entityId)),
    );

    for (const entityId of [...this.entries.keys()]) {
      if (!wanted.has(entityId)) await this.stop(entityId);
    }

    for (const [entityId, target] of wanted) {
      const existing = this.entries.get(entityId);
      if (existing) {
        if (existing.runner.containerId === target.containerId) continue;
        // Redeploy: same service, new Docker id, so the old SSE stream is dead.
        // Replacing the runner is not a lost day: openSession returns the same
        // row keyed by (host, containerKey, day) and restores its summary.
        await this.stop(entityId);
      }
      await this.start(entityId, target);
    }
  }

  private async start(entityId: string, target: FleetAnalysisTarget): Promise<void> {
    let signer: (() => Promise<string>) | null;
    try {
      signer = await this.deps.getSigner(target.host);
    } catch (err) {
      console.error(
        `[FleetLogAnalysis] Signer fetch failed for ${target.host}:`,
        err instanceof Error ? err.message : err,
      );
      return;
    }
    if (!signer) return;

    await this.deps.repo.ensureProfile(target.host, target.containerKey);

    const runner = this.deps.buildAnalyst
      ? this.deps.buildAnalyst(target, signer, this.deps.semaphore)
      : new ContainerLogAnalyst({
          identity: { host: target.host, containerKey: target.containerKey, image: target.image },
          containerId: target.containerId,
          agentUrl: target.agentUrl,
          signer,
          repo: this.deps.repo,
          models: this.deps.models,
          settings: this.deps.settings,
          semaphore: this.deps.semaphore,
        });

    const running = runner.run().catch((err) => {
      console.error(
        `[FleetLogAnalysis] Analyst for ${entityId} exited with error:`,
        err instanceof Error ? err.message : err,
      );
    });

    this.entries.set(entityId, { runner, running });
    console.info(`[FleetLogAnalysis] Watching ${entityId}`);
  }

  private async stop(entityId: string): Promise<void> {
    const entry = this.entries.get(entityId);
    if (!entry) return;
    this.entries.delete(entityId);
    entry.runner.stop();
    await entry.running;
    console.info(`[FleetLogAnalysis] Stopped watching ${entityId}`);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await Promise.all([...this.entries.keys()].map((entityId) => this.stop(entityId)));
  }
}
