import { describe, it, expect, mock } from 'bun:test';
import type { LanguageModel, ToolSet } from 'ai';
import { observationEntityId, renderObservations, triageObservations } from '@/lib/ai/triage-agent';
import type { AiObservation } from '@/types/ai';

const model = 'fake-model' as unknown as LanguageModel;
const TOOL_OPTIONS = { toolCallId: 'call-1', messages: [] } as never;

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
    evidence: ['ERROR transcode failed'],
    triaged: false,
    ...overrides,
  };
}

async function raise(tools: ToolSet | undefined, input: unknown): Promise<unknown> {
  return tools?.raise_alert?.execute?.(input as never, TOOL_OPTIONS);
}

describe('observationEntityId', () => {
  it('uses the fleet-wide host/name convention', () => {
    expect(observationEntityId({ host: 'nuc', containerKey: 'media/plex' })).toBe('nuc/media/plex');
  });
});

describe('renderObservations', () => {
  it('numbers observations and indents their evidence', () => {
    const rendered = renderObservations([observation(), observation({ id: 2, evidence: [] })]);
    expect(rendered).toContain('[1] 2026-08-14T10:00:00.000Z WARNING nuc/media/plex');
    expect(rendered).toContain('      ERROR transcode failed');
    expect(rendered).toContain('[2]');
    const second = rendered.split('\n\n')[1];
    expect(second).not.toContain('evidence:');
  });
});

describe('triageObservations', () => {
  it('returns nothing without calling the model when there is nothing to triage', async () => {
    const generate = mock(async () => ({ text: '' }));
    expect(await triageObservations({ observations: [], alertFloor: 'warning', model, generate })).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
  });

  it('maps bracket references back to observation ids and entities', async () => {
    const observations = [
      observation({ id: 11 }),
      observation({ id: 22, host: 'nas', containerKey: 'db/postgres' }),
    ];
    const generate = mock(async (args: { tools?: ToolSet }) => {
      await raise(args.tools, {
        severity: 'critical',
        title: 'Storage backend down',
        summary: 'Two services failing on the same volume',
        investigation: 'Both started at 10:00',
        observation_refs: [1, 2],
      });
      return { text: '' };
    });

    const alerts = await triageObservations({
      observations,
      alertFloor: 'warning',
      model,
      generate: generate as never,
    });

    expect(alerts).toHaveLength(1);
    expect(alerts[0].observationIds).toEqual([11, 22]);
    expect(alerts[0].entities).toEqual(['nuc/media/plex', 'nas/db/postgres']);
    expect(alerts[0].investigation).toBe('Both started at 10:00');
  });

  it('deduplicates entities when several observations share one container', async () => {
    const observations = [observation({ id: 1 }), observation({ id: 2 })];
    const generate = async (args: { tools?: ToolSet }) => {
      await raise(args.tools, {
        severity: 'warning',
        title: 'Repeat failures',
        summary: 'Same container twice',
        observation_refs: [1, 2],
      });
      return { text: '' };
    };

    const alerts = await triageObservations({
      observations,
      alertFloor: 'warning',
      model,
      generate: generate as never,
    });
    expect(alerts[0].entities).toEqual(['nuc/media/plex']);
    expect(alerts[0].investigation).toBeNull();
  });

  it('drops an alert whose references match nothing', async () => {
    const generate = async (args: { tools?: ToolSet }) => {
      const result = await raise(args.tools, {
        severity: 'warning',
        title: 'Hallucinated',
        summary: 'References an observation that was never shown',
        observation_refs: [99],
      });
      expect(result).toEqual({ raised: false, reason: 'No observation_refs matched the numbered list.' });
      return { text: '' };
    };

    const alerts = await triageObservations({
      observations: [observation()],
      alertFloor: 'warning',
      model,
      generate: generate as never,
    });
    expect(alerts).toEqual([]);
  });

  it('tells the model the operator\'s alert floor', async () => {
    let prompt = '';
    const generate = async (args: { messages: { content: string }[] }) => {
      prompt = args.messages[0].content;
      return { text: '' };
    };
    await triageObservations({
      observations: [observation()],
      alertFloor: 'critical',
      model,
      generate: generate as never,
    });
    expect(prompt).toContain('`critical`');
  });
});
