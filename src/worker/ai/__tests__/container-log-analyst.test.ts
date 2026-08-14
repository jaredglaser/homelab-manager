import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import type { AiAnalysisRepository } from '@/lib/database/repositories/ai-analysis-repository';
import type { AiAnalysisSession, AiContainerProfile, LogLine } from '@/types/ai';
import type { ContainerAnalyst, ContainerAnalystOptions } from '@/lib/ai/container-agent';
import type { AiModelSet } from '@/lib/ai/provider';
import { Semaphore } from '@/lib/ai/semaphore';
import { AI_DEFAULTS } from '@/lib/ai/config';
import { ContainerLogAnalyst } from '@/worker/ai/container-log-analyst';

const identity = { host: 'nuc', containerKey: 'media/plex', image: 'plex:latest' };

const models: AiModelSet = {
  analyst: 'analyst' as never,
  profiler: 'profiler' as never,
  analystModelId: 'analyst-8b',
  profilerModelId: 'profiler-70b',
  maxContextTokens: 32_768,
};

function profile(overrides: Partial<AiContainerProfile> = {}): AiContainerProfile {
  return {
    host: identity.host,
    containerKey: identity.containerKey,
    enabled: true,
    status: 'ready',
    skillMarkdown: '## Signals',
    skillVersion: 1,
    sampleStartedAt: null,
    sampleEndedAt: null,
    sampleLineCount: 0,
    model: null,
    error: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

function session(day: string, overrides: Partial<AiAnalysisSession> = {}): AiAnalysisSession {
  return {
    id: `session-${day}`,
    host: identity.host,
    containerKey: identity.containerKey,
    day,
    status: 'active',
    startedAt: new Date(),
    endedAt: null,
    batchesProcessed: 0,
    linesProcessed: 0,
    runningSummary: null,
    reportMarkdown: null,
    model: 'analyst-8b',
    error: null,
    ...overrides,
  };
}

interface RepoCalls {
  ensureProfile: string[];
  statuses: { status: string; error: string | null }[];
  savedSkills: { skillMarkdown: string; sampleLineCount: number }[];
  openedDays: string[];
  batches: { sessionId: string; lineCount: number; summary: string | null }[];
  closed: { sessionId: string; report: string }[];
  failed: { sessionId: string; error: string }[];
  observations: { title: string }[];
}

function fakeRepo(initial: AiContainerProfile) {
  const calls: RepoCalls = {
    ensureProfile: [],
    statuses: [],
    savedSkills: [],
    openedDays: [],
    batches: [],
    closed: [],
    failed: [],
    observations: [],
  };
  let current = initial;
  const repo = {
    async ensureProfile(host: string, containerKey: string) {
      calls.ensureProfile.push(`${host}/${containerKey}`);
      return current;
    },
    async setProfileStatus(_h: string, _k: string, status: string, error: string | null = null) {
      calls.statuses.push({ status, error });
      current = { ...current, status: status as AiContainerProfile['status'] };
    },
    async saveSkill(input: { skillMarkdown: string; sampleLineCount: number }) {
      calls.savedSkills.push({
        skillMarkdown: input.skillMarkdown,
        sampleLineCount: input.sampleLineCount,
      });
    },
    async openSession(_h: string, _k: string, day: string) {
      calls.openedDays.push(day);
      return session(day);
    },
    async recordBatch(sessionId: string, lineCount: number, summary: string | null) {
      calls.batches.push({ sessionId, lineCount, summary });
    },
    async closeSession(sessionId: string, report: string) {
      calls.closed.push({ sessionId, report });
    },
    async failSession(sessionId: string, error: string) {
      calls.failed.push({ sessionId, error });
    },
    async addObservation(input: { title: string }) {
      calls.observations.push({ title: input.title });
      return { id: 1 } as never;
    },
  } as unknown as AiAnalysisRepository;
  return { repo, calls };
}

/** Async generator the test drives frame by frame, mirroring a live agent SSE stream. */
function pushableStream() {
  const queue: unknown[] = [];
  let notify: (() => void) | null = null;
  let finished = false;

  const generator = (async function* () {
    while (true) {
      while (queue.length > 0) yield queue.shift();
      if (finished) return;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  })();

  return {
    generator,
    push(frame: unknown) {
      queue.push(frame);
      notify?.();
      notify = null;
    },
    end() {
      finished = true;
      notify?.();
      notify = null;
    },
  };
}

function frame(text: string): unknown {
  return { stream: 'stdout', text: `2026-08-14T10:00:00.000000000Z ${text}` };
}

interface AnalystStub {
  ingest: (lines: LogLine[]) => Promise<{ observations: never[]; summary: string | null; compacted: boolean }>;
  writeDailyReport: () => Promise<string>;
  batchesProcessed: number;
}

function stubAnalyst(overrides: Partial<AnalystStub> = {}): ContainerAnalyst {
  return {
    ingest: async () => ({ observations: [], summary: 'summary', compacted: false }),
    writeDailyReport: async () => '## Summary\nQuiet day.',
    batchesProcessed: 1,
    ...overrides,
  } as unknown as ContainerAnalyst;
}

describe('ContainerLogAnalyst', () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spyOn(console, 'info').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    spyOn(console, 'log').mockImplementation(() => {});
  });

  function build(options: {
    repo: AiAnalysisRepository;
    controller: AbortController;
    connectImpl: () => Promise<AsyncGenerator<unknown, void, void>>;
    fetchHistory?: () => Promise<LogLine[]>;
    generateSkill?: (input: { history: LogLine[] }) => Promise<unknown>;
    analyst?: ContainerAnalyst;
    onAnalystOptions?: (options: ContainerAnalystOptions) => void;
    now?: () => Date;
    batchLines?: number;
    idleFlushMs?: number;
  }): ContainerLogAnalyst {
    return new ContainerLogAnalyst({
      identity,
      containerId: 'abc123',
      agentUrl: 'http://agent:9090',
      signer: async () => 'jwt',
      repo: options.repo,
      models,
      settings: { ...AI_DEFAULTS, batchLines: options.batchLines ?? 2 },
      semaphore: new Semaphore(2),
      abortController: options.controller,
      now: options.now ?? (() => new Date('2026-08-14T10:00:00Z')),
      connect: options.connectImpl as never,
      fetchHistory: (options.fetchHistory ?? (async () => [])) as never,
      ...(options.generateSkill ? { generateSkill: options.generateSkill as never } : {}),
      buildAnalyst: (analystOptions) => {
        options.onAnalystOptions?.(analystOptions);
        return options.analyst ?? stubAnalyst();
      },
      idleFlushMs: options.idleFlushMs ?? 60_000,
    });
  }

  it('exposes the container id it is following', () => {
    const { repo } = fakeRepo(profile());
    const controller = new AbortController();
    const stream = pushableStream();
    const runner = build({ repo, controller, connectImpl: async () => stream.generator });
    expect(runner.containerId).toBe('abc123');
    controller.abort();
  });

  it('opens today\'s session and feeds full batches to the analyst', async () => {
    const { repo, calls } = fakeRepo(profile());
    const controller = new AbortController();
    const stream = pushableStream();
    let resolveBatch: () => void = () => {};
    const batchSeen = new Promise<void>((resolve) => {
      resolveBatch = resolve;
    });
    const ingested: LogLine[][] = [];
    const analyst = stubAnalyst({
      ingest: async (lines: LogLine[]) => {
        ingested.push(lines);
        return { observations: [], summary: 'running state', compacted: false };
      },
    });
    const trackingRepo = {
      ...repo,
      recordBatch: async (sessionId: string, lineCount: number, summary: string | null) => {
        await repo.recordBatch(sessionId, lineCount, summary);
        resolveBatch();
      },
    } as unknown as AiAnalysisRepository;

    const runner = build({ repo: trackingRepo, controller, connectImpl: async () => stream.generator, analyst });
    const running = runner.run();

    stream.push(frame('line one'));
    stream.push(frame('line two'));
    await batchSeen;

    expect(calls.openedDays).toEqual(['2026-08-14']);
    expect(ingested[0].map((line) => line.text)).toEqual(['line one', 'line two']);
    expect(calls.batches).toEqual([
      { sessionId: 'session-2026-08-14', lineCount: 2, summary: 'running state' },
    ]);

    controller.abort();
    await running;
  });

  it('skips frames that are not log lines', async () => {
    const { repo, calls } = fakeRepo(profile());
    const controller = new AbortController();
    const stream = pushableStream();
    let resolveBatch: () => void = () => {};
    const batchSeen = new Promise<void>((resolve) => {
      resolveBatch = resolve;
    });
    const trackingRepo = {
      ...repo,
      recordBatch: async (sessionId: string, lineCount: number, summary: string | null) => {
        await repo.recordBatch(sessionId, lineCount, summary);
        resolveBatch();
      },
    } as unknown as AiAnalysisRepository;

    const runner = build({ repo: trackingRepo, controller, connectImpl: async () => stream.generator });
    const running = runner.run();

    stream.push({ heartbeat: true });
    stream.push(frame('real one'));
    stream.push(frame('real two'));
    await batchSeen;

    expect(calls.batches[0].lineCount).toBe(2);
    controller.abort();
    await running;
  });

  it('profiles a new container before analysing anything', async () => {
    const { repo, calls } = fakeRepo(profile({ status: 'pending', skillMarkdown: null }));
    const controller = new AbortController();
    const stream = pushableStream();
    let resolveOpened: () => void = () => {};
    const opened = new Promise<void>((resolve) => {
      resolveOpened = resolve;
    });
    const trackingRepo = {
      ...repo,
      openSession: async (host: string, key: string, day: string, model: string) => {
        const result = await repo.openSession(host, key, day, model);
        resolveOpened();
        return result;
      },
    } as unknown as AiAnalysisRepository;

    let profiledLines = 0;
    const runner = build({
      repo: trackingRepo,
      controller,
      connectImpl: async () => stream.generator,
      fetchHistory: async () => [{ at: 1, stream: 'stdout' as const, text: 'historical' }],
      generateSkill: async (input: { history: LogLine[] }) => {
        profiledLines = input.history.length;
        return {
          skillMarkdown: '## Format\nauthored',
          modelId: 'profiler-70b',
          sampleLineCount: input.history.length,
          sampleStartedAt: new Date(0),
          sampleEndedAt: new Date(1000),
        };
      },
    });

    const running = runner.run();
    await opened;

    expect(calls.statuses[0]).toEqual({ status: 'profiling', error: null });
    expect(profiledLines).toBe(1);
    expect(calls.savedSkills).toEqual([{ skillMarkdown: '## Format\nauthored', sampleLineCount: 1 }]);

    controller.abort();
    await running;
  });

  it('marks the profile failed when the profiler throws', async () => {
    const { repo, calls } = fakeRepo(profile({ status: 'pending', skillMarkdown: null }));
    const controller = new AbortController();
    const stream = pushableStream();

    const runner = build({
      repo,
      controller,
      connectImpl: async () => stream.generator,
      fetchHistory: async () => {
        throw new Error('agent unreachable');
      },
    });

    const running = runner.run();
    // The first cycle fails inside ensureSkill; abort before the backoff retry.
    while (calls.statuses.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await running;

    expect(calls.statuses[0].status).toBe('profiling');
    expect(calls.statuses[1]).toEqual({ status: 'failed', error: 'agent unreachable' });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('closes the day and opens the next one when the clock rolls over', async () => {
    const { repo, calls } = fakeRepo(profile());
    const controller = new AbortController();
    const stream = pushableStream();
    let day = '2026-08-14T10:00:00Z';

    let resolveSecondDay: () => void = () => {};
    const secondDayOpened = new Promise<void>((resolve) => {
      resolveSecondDay = resolve;
    });

    const trackingRepo = {
      ...repo,
      openSession: async (host: string, key: string, requestedDay: string, model: string) => {
        const result = await repo.openSession(host, key, requestedDay, model);
        if (requestedDay === '2026-08-15') resolveSecondDay();
        return result;
      },
    } as unknown as AiAnalysisRepository;

    const analyst = stubAnalyst({
      ingest: async () => {
        day = '2026-08-15T00:05:00Z';
        return { observations: [], summary: 'carry', compacted: false };
      },
    });

    const runner = build({
      repo: trackingRepo,
      controller,
      connectImpl: async () => stream.generator,
      analyst,
      now: () => new Date(day),
    });

    const running = runner.run();
    stream.push(frame('a'));
    stream.push(frame('b'));
    await secondDayOpened;

    expect(calls.openedDays).toEqual(['2026-08-14', '2026-08-15']);
    expect(calls.closed).toEqual([
      { sessionId: 'session-2026-08-14', report: '## Summary\nQuiet day.' },
    ]);

    controller.abort();
    await running;
  });

  it('records a failed session when the daily report cannot be written', async () => {
    const { repo, calls } = fakeRepo(profile());
    const controller = new AbortController();
    const stream = pushableStream();
    let day = '2026-08-14T10:00:00Z';

    let resolveFailed: () => void = () => {};
    const sessionFailed = new Promise<void>((resolve) => {
      resolveFailed = resolve;
    });
    const trackingRepo = {
      ...repo,
      failSession: async (sessionId: string, error: string) => {
        await repo.failSession(sessionId, error);
        resolveFailed();
      },
    } as unknown as AiAnalysisRepository;

    const analyst = stubAnalyst({
      ingest: async () => {
        day = '2026-08-15T00:05:00Z';
        return { observations: [], summary: null, compacted: false };
      },
      writeDailyReport: async () => {
        throw new Error('endpoint timeout');
      },
    });

    const runner = build({
      repo: trackingRepo,
      controller,
      connectImpl: async () => stream.generator,
      analyst,
      now: () => new Date(day),
    });

    const running = runner.run();
    stream.push(frame('a'));
    stream.push(frame('b'));
    await sessionFailed;

    expect(calls.failed).toEqual([
      { sessionId: 'session-2026-08-14', error: 'endpoint timeout' },
    ]);
    expect(calls.closed).toEqual([]);

    controller.abort();
    await running;
  });

  it('wires the analyst to the skill, the day\'s summary and an observation sink', async () => {
    const { repo, calls } = fakeRepo(profile({ status: 'ready', skillMarkdown: '## Signals' }));
    const controller = new AbortController();
    const stream = pushableStream();

    let seen: ContainerAnalystOptions | null = null;
    let resolveSeen: () => void = () => {};
    const built = new Promise<void>((resolve) => {
      resolveSeen = resolve;
    });

    const runner = build({
      repo,
      controller,
      connectImpl: async () => stream.generator,
      onAnalystOptions: (options) => {
        seen = options;
        resolveSeen();
      },
    });

    const running = runner.run();
    await built;

    expect(seen!.skillMarkdown).toBe('## Signals');
    expect(seen!.day).toBe('2026-08-14');
    expect(seen!.identity).toEqual(identity);

    await seen!.onObservation({
      severity: 'warning',
      title: 'Connection resets',
      detail: 'Seven in one batch',
      evidence: ['ERROR'],
    });
    expect(calls.observations).toEqual([{ title: 'Connection resets' }]);

    controller.abort();
    await running;
  });

  it('flushes a partial batch when the container goes quiet', async () => {
    const { repo, calls } = fakeRepo(profile());
    const controller = new AbortController();
    const stream = pushableStream();

    let resolveFlushed: () => void = () => {};
    const flushed = new Promise<void>((resolve) => {
      resolveFlushed = resolve;
    });
    const trackingRepo = {
      ...repo,
      recordBatch: async (sessionId: string, lineCount: number, summary: string | null) => {
        await repo.recordBatch(sessionId, lineCount, summary);
        resolveFlushed();
      },
    } as unknown as AiAnalysisRepository;

    const runner = build({
      repo: trackingRepo,
      controller,
      connectImpl: async () => stream.generator,
      batchLines: 50,
      idleFlushMs: 5,
    });

    const running = runner.run();
    stream.push(frame('lonely line'));
    await flushed;

    expect(calls.batches[0].lineCount).toBe(1);
    controller.abort();
    await running;
  });

  it('flushes a partial batch when the stream ends', async () => {
    const { repo, calls } = fakeRepo(profile());
    const controller = new AbortController();
    const stream = pushableStream();

    let resolveFlushed: () => void = () => {};
    const flushed = new Promise<void>((resolve) => {
      resolveFlushed = resolve;
    });
    const trackingRepo = {
      ...repo,
      recordBatch: async (sessionId: string, lineCount: number, summary: string | null) => {
        await repo.recordBatch(sessionId, lineCount, summary);
        resolveFlushed();
      },
    } as unknown as AiAnalysisRepository;

    const runner = build({
      repo: trackingRepo,
      controller,
      connectImpl: async () => stream.generator,
      batchLines: 10,
    });

    const running = runner.run();
    stream.push(frame('only line'));
    stream.end();
    await flushed;

    expect(calls.batches[0].lineCount).toBe(1);
    controller.abort();
    await running;
  });

});
