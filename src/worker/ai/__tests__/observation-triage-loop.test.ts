import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import type { AiAnalysisRepository } from '@/lib/database/repositories/ai-analysis-repository';
import type { AiObservation, AiSeverity } from '@/types/ai';
import { AI_DEFAULTS } from '@/lib/ai/config';
import type { AiModelSet } from '@/lib/ai/provider';
import { Semaphore } from '@/lib/ai/semaphore';
import type { RaisedAlert } from '@/lib/ai/triage-agent';
import {
  runObservationTriageLoop,
  runTriagePass,
  shouldTriage,
} from '@/worker/ai/observation-triage-loop';

const models: AiModelSet = {
  analyst: 'analyst' as never,
  profiler: 'profiler' as never,
  analystModelId: 'analyst-8b',
  profilerModelId: 'profiler-70b',
  maxContextTokens: 32_768,
};

function observation(overrides: Partial<AiObservation> = {}): AiObservation {
  return {
    id: 1,
    sessionId: 'session-1',
    host: 'nuc',
    containerKey: 'media/plex',
    at: new Date('2026-08-14T10:00:00Z'),
    severity: 'warning',
    title: 'Transcode failures',
    detail: 'Four in a row',
    evidence: [],
    triaged: false,
    ...overrides,
  };
}

function repoWith(claimed: AiObservation[], raised: RaisedAlert[] = []) {
  return {
    claimUntriaged: async () => claimed,
    addAlert: async (alert: RaisedAlert) => {
      raised.push(alert);
      return { id: raised.length } as never;
    },
  } as unknown as AiAnalysisRepository;
}

describe('shouldTriage', () => {
  it('skips an empty claim', () => {
    expect(shouldTriage([], AI_DEFAULTS)).toBe(false);
  });

  it('triages as soon as one observation clears the floor', () => {
    expect(shouldTriage([observation({ severity: 'warning' })], AI_DEFAULTS)).toBe(true);
  });

  it('skips a lone low-severity observation', () => {
    expect(shouldTriage([observation({ severity: 'info' })], AI_DEFAULTS)).toBe(false);
  });

  it('triages low-severity chatter once it spans three containers', () => {
    const spread = ['a', 'b', 'c'].map((key, index) =>
      observation({ id: index, severity: 'info', containerKey: key }),
    );
    expect(shouldTriage(spread, AI_DEFAULTS)).toBe(true);
  });

  it('does not treat repeats from one container as a fleet pattern', () => {
    const repeats = [1, 2, 3, 4].map((id) => observation({ id, severity: 'notice' }));
    expect(shouldTriage(repeats, AI_DEFAULTS)).toBe(false);
  });

  it('honours a raised alert floor', () => {
    const settings = { ...AI_DEFAULTS, alertSeverity: 'critical' as AiSeverity };
    expect(shouldTriage([observation({ severity: 'warning' })], settings)).toBe(false);
    expect(shouldTriage([observation({ severity: 'critical' })], settings)).toBe(true);
  });
});

describe('runTriagePass', () => {
  let infoSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    infoSpy = spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  const deps = (repo: AiAnalysisRepository) => ({
    repo,
    models,
    settings: AI_DEFAULTS,
    semaphore: new Semaphore(1),
    signal: new AbortController().signal,
  });

  it('returns nothing when there is nothing worth triaging', async () => {
    expect(await runTriagePass(deps(repoWith([])))).toEqual([]);
  });

  it('returns nothing when the claim is all below the floor', async () => {
    expect(await runTriagePass(deps(repoWith([observation({ severity: 'info' })])))).toEqual([]);
  });

  it('persists every alert the orchestrator raises', async () => {
    const raised: RaisedAlert[] = [];
    const repo = repoWith([observation()], raised);
    const alert: RaisedAlert = {
      severity: 'critical',
      title: 'Storage down',
      summary: 'Two services failing',
      investigation: null,
      entities: ['nuc/media/plex'],
      observationIds: [1],
    };

    const result = await runTriagePass({
      ...deps(repo),
      triage: (async () => [alert]) as never,
    });

    expect(result).toEqual([alert]);
    expect(raised).toEqual([alert]);
    expect(infoSpy.mock.calls.flat().join(' ')).toContain('Storage down');
  });

  it('passes the operator floor and the claimed observations to the orchestrator', async () => {
    let seen: { alertFloor: string; observations: AiObservation[] } | null = null;
    const claimed = [observation()];
    await runTriagePass({
      ...deps(repoWith(claimed)),
      triage: (async (input: { alertFloor: string; observations: AiObservation[] }) => {
        seen = input;
        return [];
      }) as never,
    });

    expect(seen).not.toBeNull();
    expect(seen!.alertFloor).toBe(AI_DEFAULTS.alertSeverity);
    expect(seen!.observations).toEqual(claimed);
  });
});

describe('runObservationTriageLoop', () => {
  let originalSetTimeout: typeof setTimeout;

  beforeEach(() => {
    spyOn(console, 'info').mockImplementation(() => {});
    spyOn(console, 'error').mockImplementation(() => {});
    originalSetTimeout = globalThis.setTimeout;
    // Fire the interval immediately so the loop runs a pass without real waiting.
    globalThis.setTimeout = ((fn: () => void) => {
      queueMicrotask(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
  });

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout;
  });

  it('runs passes until the signal aborts', async () => {
    const controller = new AbortController();
    let claims = 0;
    const repo = {
      claimUntriaged: async () => {
        claims += 1;
        if (claims >= 2) controller.abort();
        return [];
      },
      addAlert: async () => ({ id: 1 }) as never,
    } as unknown as AiAnalysisRepository;

    await runObservationTriageLoop({
      repo,
      models,
      settings: AI_DEFAULTS,
      semaphore: new Semaphore(1),
      signal: controller.signal,
      intervalMs: 1,
    });

    expect(claims).toBeGreaterThanOrEqual(2);
  });

  it('keeps going after a failed pass', async () => {
    const controller = new AbortController();
    let claims = 0;
    const repo = {
      claimUntriaged: async () => {
        claims += 1;
        if (claims === 1) throw new Error('db down');
        controller.abort();
        return [];
      },
      addAlert: async () => ({ id: 1 }) as never,
    } as unknown as AiAnalysisRepository;

    await runObservationTriageLoop({
      repo,
      models,
      settings: AI_DEFAULTS,
      semaphore: new Semaphore(1),
      signal: controller.signal,
      intervalMs: 1,
    });

    expect(claims).toBe(2);
  });

  it('returns immediately when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let claims = 0;
    const repo = {
      claimUntriaged: async () => {
        claims += 1;
        return [];
      },
      addAlert: async () => ({ id: 1 }) as never,
    } as unknown as AiAnalysisRepository;

    await runObservationTriageLoop({
      repo,
      models,
      settings: AI_DEFAULTS,
      semaphore: new Semaphore(1),
      signal: controller.signal,
      intervalMs: 1,
    });

    expect(claims).toBe(0);
  });

  it('stops when a pass aborts mid-flight', async () => {
    const controller = new AbortController();
    const repo = {
      claimUntriaged: async () => {
        controller.abort();
        throw new DOMException('Aborted', 'AbortError');
      },
      addAlert: async () => ({ id: 1 }) as never,
    } as unknown as AiAnalysisRepository;

    await runObservationTriageLoop({
      repo,
      models,
      settings: AI_DEFAULTS,
      semaphore: new Semaphore(1),
      signal: controller.signal,
      intervalMs: 1,
    });

    expect(controller.signal.aborted).toBe(true);
  });
});
