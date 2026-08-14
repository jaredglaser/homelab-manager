import type { AiAnalysisRepository } from '@/lib/database/repositories/ai-analysis-repository';
import type { AiAnalysisSession, AiContainerProfile, LogLine } from '@/types/ai';
import { ContainerAnalyst, type ContainerAnalystOptions } from '@/lib/ai/container-agent';
import { utcDay } from '@/lib/ai/day';
import { LogBatcher } from '@/lib/ai/log-batcher';
import { fetchLogHistory, normalizeLiveLogFrame } from '@/lib/ai/log-source';
import { generateContainerSkill } from '@/lib/ai/profiler-agent';
import type { ContainerIdentity } from '@/lib/ai/prompts';
import type { AiModelSet } from '@/lib/ai/provider';
import type { Semaphore } from '@/lib/ai/semaphore';
import type { AiRuntimeSettings } from '@/lib/ai/config';
import { connectAgentSseStream } from '@/worker/collectors/agent-sse-stream';
import { BaseCollector } from '@/worker/collectors/base-collector';

/** Quiet containers still get analysed: a partial batch is flushed after this long with no new lines. */
const IDLE_FLUSH_MS = 120_000;
/** Ceiling on the profiler's history pull. The agent caps it too; this is the ask. */
const PROFILE_MAX_LINES = 20_000;
/** Chars per batch. Sized so a batch plus the running summary clears a 32k window. */
const BATCH_MAX_CHARS = 24_000;

export interface ContainerLogAnalystDeps {
  identity: ContainerIdentity;
  /** Docker id of the container currently backing this key; changes on redeploy. */
  containerId: string;
  agentUrl: string;
  signer: () => Promise<string>;
  repo: AiAnalysisRepository;
  models: AiModelSet;
  settings: AiRuntimeSettings;
  semaphore: Semaphore;
  abortController?: AbortController;
  now?: () => Date;
  connect?: typeof connectAgentSseStream;
  fetchHistory?: typeof fetchLogHistory;
  generateSkill?: typeof generateContainerSkill;
  /** Receives exactly the options the real analyst is built from. */
  buildAnalyst?: (options: ContainerAnalystOptions) => ContainerAnalyst;
  idleFlushMs?: number;
}

interface CancellableDelay {
  promise: Promise<'idle'>;
  cancel: () => void;
}

function delay(ms: number, signal: AbortSignal): CancellableDelay {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const promise = new Promise<'idle'>((resolve) => {
    if (signal.aborted) {
      resolve('idle');
      return;
    }
    timer = setTimeout(() => resolve('idle'), ms);
    onAbort = () => resolve('idle');
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return {
    promise,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Watches one container's logs for as long as it exists: authors its analysis
 * skill on first sight, then feeds a per-day analyst batches of live log lines
 * and closes each day with a written report.
 *
 * Inherits BaseCollector's reconnect-with-backoff loop, so an agent restart or
 * a container that stops and starts again resumes without losing the session:
 * the day's rolling summary lives in `ai_analysis_sessions`, not in memory.
 */
export class ContainerLogAnalyst extends BaseCollector {
  readonly name: string;

  private readonly batcher: LogBatcher;
  private readonly connect: typeof connectAgentSseStream;
  private readonly fetchHistory: typeof fetchLogHistory;
  private readonly generateSkill: typeof generateContainerSkill;
  private readonly now: () => Date;
  private readonly idleFlushMs: number;
  private analyst: ContainerAnalyst | null = null;
  private session: AiAnalysisSession | null = null;
  private skillMarkdown: string | null = null;

  constructor(private readonly deps: ContainerLogAnalystDeps) {
    super(undefined, undefined, deps.abortController);
    this.name = `AI:${deps.identity.host}/${deps.identity.containerKey}`;
    this.batcher = new LogBatcher({
      maxLines: deps.settings.batchLines,
      maxChars: BATCH_MAX_CHARS,
    });
    this.connect = deps.connect ?? connectAgentSseStream;
    this.fetchHistory = deps.fetchHistory ?? fetchLogHistory;
    this.generateSkill = deps.generateSkill ?? generateContainerSkill;
    this.now = deps.now ?? (() => new Date());
    this.idleFlushMs = deps.idleFlushMs ?? IDLE_FLUSH_MS;
  }

  get containerId(): string {
    return this.deps.containerId;
  }

  protected async collect(): Promise<void> {
    await this.ensureSkill();
    await this.rotateSessionIfNeeded();
    this.resetBackoff();

    const stream = await this.connect({
      agentUrl: this.deps.agentUrl,
      path: `/logs/${this.deps.containerId}`,
      signer: this.deps.signer,
      signal: this.signal,
    });

    const iterator = stream[Symbol.asyncIterator]();
    let pendingNext = iterator.next();

    try {
      while (!this.signal.aborted) {
        const idle = delay(this.idleFlushMs, this.signal);
        let outcome: IteratorResult<unknown, void> | 'idle';
        try {
          outcome = await Promise.race([pendingNext, idle.promise]);
        } finally {
          idle.cancel();
        }

        if (outcome === 'idle') {
          await this.flushPending();
          await this.rotateSessionIfNeeded();
          continue;
        }

        if (outcome.done) break;
        pendingNext = iterator.next();

        const line = normalizeLiveLogFrame(outcome.value);
        if (!line) continue;

        const batch = this.batcher.push(line);
        if (batch) {
          await this.processBatch(batch);
          await this.rotateSessionIfNeeded();
        }
      }
    } finally {
      // Not awaited: the upstream generator is suspended on a read that only
      // unblocks when the abort tears the connection down, so awaiting the
      // return would deadlock the teardown it is part of.
      void iterator.return?.().catch(() => {});
    }

    if (!this.signal.aborted) await this.flushPending();
  }

  private async flushPending(): Promise<void> {
    const batch = this.batcher.drain();
    if (batch) await this.processBatch(batch);
  }

  private async processBatch(lines: LogLine[]): Promise<void> {
    const analyst = this.analyst;
    const session = this.session;
    if (!analyst || !session) return;

    const result = await this.deps.semaphore.run(() => analyst.ingest(lines));
    await this.deps.repo.recordBatch(session.id, lines.length, result.summary);
  }

  /**
   * Reads the container's history and writes its bespoke skill the first time
   * it is seen. A profile whose earlier attempt failed is retried here, which
   * is what BaseCollector's backoff is pacing.
   */
  private async ensureSkill(): Promise<void> {
    if (this.skillMarkdown !== null) return;

    const { host, containerKey } = this.deps.identity;
    const existing: AiContainerProfile = await this.deps.repo.ensureProfile(host, containerKey);
    if (existing.status === 'ready' && existing.skillMarkdown !== null) {
      this.skillMarkdown = existing.skillMarkdown;
      return;
    }

    await this.deps.repo.setProfileStatus(host, containerKey, 'profiling');
    console.info(`[${this.name}] Profiling ${this.deps.settings.profileWindowDays}d of history to author its skill`);

    try {
      const since = new Date(this.now().getTime() - this.deps.settings.profileWindowDays * 86_400_000);
      const history = await this.fetchHistory({
        agentUrl: this.deps.agentUrl,
        containerId: this.deps.containerId,
        signer: this.deps.signer,
        since,
        maxLines: PROFILE_MAX_LINES,
        signal: this.signal,
      });

      const result = await this.deps.semaphore.run(() =>
        this.generateSkill({
          identity: this.deps.identity,
          history,
          windowDays: this.deps.settings.profileWindowDays,
          model: this.deps.models.profiler,
          modelId: this.deps.models.profilerModelId,
          maxContextTokens: this.deps.models.maxContextTokens,
          abortSignal: this.signal,
        }),
      );

      await this.deps.repo.saveSkill({
        host,
        containerKey,
        skillMarkdown: result.skillMarkdown,
        model: result.modelId,
        sampleStartedAt: result.sampleStartedAt,
        sampleEndedAt: result.sampleEndedAt,
        sampleLineCount: result.sampleLineCount,
      });
      this.skillMarkdown = result.skillMarkdown;
      console.info(`[${this.name}] Skill written from ${result.sampleLineCount} sampled lines`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.deps.repo.setProfileStatus(host, containerKey, 'failed', message);
      throw err;
    }
  }

  private async rotateSessionIfNeeded(): Promise<void> {
    const day = utcDay(this.now());
    if (this.session?.day === day && this.analyst !== null) return;

    if (this.session !== null && this.analyst !== null) {
      await this.closeDay();
    }

    const { host, containerKey } = this.deps.identity;
    const session = await this.deps.repo.openSession(host, containerKey, day, this.deps.models.analystModelId);
    this.session = session;
    this.analyst = this.buildAnalyst(session);
  }

  private buildAnalyst(session: AiAnalysisSession): ContainerAnalyst {
    const options: ContainerAnalystOptions = {
      identity: this.deps.identity,
      skillMarkdown: this.skillMarkdown ?? '',
      day: session.day,
      model: this.deps.models.analyst,
      maxContextTokens: this.deps.models.maxContextTokens,
      initialSummary: session.runningSummary,
      abortSignal: this.signal,
      onObservation: (observation) =>
        this.deps.repo.addObservation({
          sessionId: session.id,
          host: this.deps.identity.host,
          containerKey: this.deps.identity.containerKey,
          severity: observation.severity,
          title: observation.title,
          detail: observation.detail,
          evidence: observation.evidence,
        }).then(() => {}),
    };
    return this.deps.buildAnalyst ? this.deps.buildAnalyst(options) : new ContainerAnalyst(options);
  }

  /** Writes the day's report and closes the session. A failure here must not kill the loop. */
  private async closeDay(): Promise<void> {
    const analyst = this.analyst;
    const session = this.session;
    if (!analyst || !session) return;

    try {
      await this.flushPending();
      const report = await this.deps.semaphore.run(() => analyst.writeDailyReport());
      await this.deps.repo.closeSession(session.id, report);
      console.info(`[${this.name}] Closed ${session.day} after ${analyst.batchesProcessed} batch(es)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${this.name}] Daily report failed for ${session.day}: ${message}`);
      await this.deps.repo.failSession(session.id, message).catch(() => {});
    } finally {
      this.analyst = null;
      this.session = null;
    }
  }
}
