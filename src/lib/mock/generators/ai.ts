import { AI_DEFAULTS } from '@/lib/ai/config';
import { DOCKER_ENTITIES } from '@/lib/mock/entities';
import type {
  AiAlert,
  AiAnalysisSession,
  AiAnalysisSnapshot,
  AiContainerProfile,
  AiObservation,
  AiProviderConfig,
} from '@/types/ai';

/** Fixed reference point so the demo renders the same story on every load. */
const NOW = new Date('2026-08-14T14:00:00Z');
const DAY = '2026-08-14';

export const MOCK_AI_PROVIDER: AiProviderConfig = {
  baseUrl: 'http://gpu-box.lan:8080/v1',
  model: 'qwen3-30b-instruct',
  profilerModel: 'qwen3-72b-instruct',
  hasApiKey: false,
  maxContextTokens: 32_768,
};

export const MOCK_AI_SETTINGS = { ...AI_DEFAULTS, enabled: true };

const SKILL_MARKDOWN = `## Format
\`<ISO8601> [<LEVEL>] <component>: <message>\`. Stack traces continue on indented lines until the next timestamped line.

## Normal
A \`[INFO] scheduler: tick\` line every 30s. Startup emits four \`[INFO] boot:\` lines in a fixed order.

## Signals
- \`[ERROR] db: connection reset\` - warning at more than five per batch.
- \`[FATAL]\` on any component - critical, always report.

## Escalation
A single connection reset is noise. Report on the sixth in one batch, or on any FATAL.

## Unknowns
The sample contains no restart, so shutdown behaviour is undetermined.`;

function entity(index: number) {
  return DOCKER_ENTITIES[index % DOCKER_ENTITIES.length];
}

function profileFor(index: number, overrides: Partial<AiContainerProfile> = {}): AiContainerProfile {
  const source = entity(index);
  return {
    host: source.host,
    containerKey: source.serviceKey,
    enabled: true,
    status: 'ready',
    skillMarkdown: SKILL_MARKDOWN,
    skillVersion: 1,
    sampleStartedAt: new Date(NOW.getTime() - 7 * 86_400_000),
    sampleEndedAt: NOW,
    sampleLineCount: 3800 + index * 120,
    model: MOCK_AI_PROVIDER.profilerModel,
    error: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function sessionFor(index: number, overrides: Partial<AiAnalysisSession> = {}): AiAnalysisSession {
  const source = entity(index);
  return {
    id: `session-${index}`,
    host: source.host,
    containerKey: source.serviceKey,
    day: DAY,
    status: 'active',
    startedAt: new Date(`${DAY}T00:00:00Z`),
    endedAt: null,
    batchesProcessed: 12 + index * 3,
    linesProcessed: 2400 + index * 600,
    runningSummary: 'Steady traffic, no unresolved issues.',
    reportMarkdown: null,
    model: MOCK_AI_PROVIDER.model,
    ...overrides,
    error: null,
  };
}

export function generateAiSnapshot(): AiAnalysisSnapshot {
  const profiles: AiContainerProfile[] = [
    profileFor(0),
    profileFor(1),
    profileFor(2, { status: 'profiling', skillMarkdown: null, skillVersion: 0, sampleLineCount: 0 }),
    profileFor(3, { enabled: false }),
  ];

  const sessions: AiAnalysisSession[] = [
    sessionFor(0),
    sessionFor(1, {
      status: 'closed',
      endedAt: new Date(`${DAY}T13:00:00Z`),
      reportMarkdown:
        '## Summary\nA normal day.\n\n## What happened\n- 4 connection resets between 09:12 and 09:20, all recovered.\n\n## Still open\nNothing.',
    }),
  ];

  const observations: AiObservation[] = [
    {
      id: 2,
      sessionId: 'session-0',
      host: profiles[0].host,
      containerKey: profiles[0].containerKey,
      at: new Date(`${DAY}T12:41:00Z`),
      severity: 'warning',
      title: 'Connection resets above the skill threshold',
      detail: 'Seven resets in one batch, against a documented threshold of five.',
      evidence: [
        '2026-08-14T12:40:51Z [ERROR] db: connection reset by peer',
        '2026-08-14T12:40:53Z [ERROR] db: connection reset by peer',
      ],
      triaged: true,
    },
    {
      id: 1,
      sessionId: 'session-1',
      host: profiles[1].host,
      containerKey: profiles[1].containerKey,
      at: new Date(`${DAY}T09:14:00Z`),
      severity: 'notice',
      title: 'Slower scheduler ticks',
      detail: 'Tick interval drifted from 30s to 44s for about six minutes, then recovered.',
      evidence: [],
      triaged: true,
    },
  ];

  const alerts: AiAlert[] = [
    {
      id: 1,
      at: new Date(`${DAY}T12:43:00Z`),
      severity: 'warning',
      title: 'Database connection resets across two services',
      summary:
        'Two containers on different hosts began resetting database connections within three minutes of each other.',
      investigation:
        'Both analysts filed resets against the same upstream. Neither container restarted, so the shared database is the likely source.',
      entities: [
        `${profiles[0].host}/${profiles[0].containerKey}`,
        `${profiles[1].host}/${profiles[1].containerKey}`,
      ],
      observationIds: [1, 2],
      status: 'open',
    },
  ];

  return { profiles, sessions, observations, alerts };
}
