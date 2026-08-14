import { describe, it, expect } from 'bun:test';
import type { LanguageModel, ToolSet } from 'ai';
import { ContainerAnalyst, type ReportedObservation } from '@/lib/ai/container-agent';
import type { GenerateArgs } from '@/lib/ai/text-generator';
import type { LogLine } from '@/types/ai';

const model = 'fake-model' as unknown as LanguageModel;
const identity = { host: 'nuc', containerKey: 'media/plex', image: 'plex:latest' };

function batch(count = 2): LogLine[] {
  return Array.from({ length: count }, (_, i) => ({
    at: 1_700_000_000_000 + i * 1000,
    stream: 'stdout' as const,
    text: `line ${i}`,
  }));
}

/** Minimal ToolCallOptions; the tools under test read none of it. */
const TOOL_OPTIONS = { toolCallId: 'call-1', messages: [] } as never;

async function callTool(tools: ToolSet | undefined, name: string, input: unknown): Promise<void> {
  const tool = tools?.[name];
  await tool?.execute?.(input as never, TOOL_OPTIONS);
}

function analyst(
  generate: (args: GenerateArgs<ToolSet>) => Promise<{ text: string }>,
  onObservation: (observation: ReportedObservation) => Promise<void> = async () => {},
  initialSummary: string | null = null,
): ContainerAnalyst {
  return new ContainerAnalyst({
    identity,
    skillMarkdown: '## Signals\nERROR means trouble',
    day: '2026-08-14',
    model,
    maxContextTokens: 32_768,
    onObservation,
    initialSummary,
    generate: generate as never,
  });
}

describe('ContainerAnalyst.ingest', () => {
  it('files observations through the sink and returns them', async () => {
    const filed: ReportedObservation[] = [];
    const subject = analyst(
      async (args) => {
        await callTool(args.tools, 'report_observation', {
          severity: 'warning',
          title: 'Connection resets',
          detail: 'Six resets in this batch',
          evidence: ['line 0'],
        });
        return { text: 'done' };
      },
      async (observation) => {
        filed.push(observation);
      },
    );

    const result = await subject.ingest(batch());
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].title).toBe('Connection resets');
    expect(filed).toEqual(result.observations);
    expect(subject.observationsFiled).toBe(1);
  });

  it('adopts the summary the agent writes', async () => {
    const subject = analyst(async (args) => {
      await callTool(args.tools, 'update_summary', { summary: 'quiet so far' });
      return { text: '' };
    });

    const result = await subject.ingest(batch());
    expect(result.summary).toBe('quiet so far');
    expect(subject.summary).toBe('quiet so far');
  });

  it('keeps the prior summary when the agent does not update it', async () => {
    const subject = analyst(async () => ({ text: 'nothing to add' }), async () => {}, 'yesterday state');
    const result = await subject.ingest(batch());
    expect(result.summary).toBe('yesterday state');
  });

  it('numbers batches and puts the rendered lines in the prompt', async () => {
    const seen: string[] = [];
    const subject = analyst(async (args) => {
      seen.push(String(args.messages.at(-1)?.content));
      return { text: 'ok' };
    });

    await subject.ingest(batch());
    await subject.ingest(batch());

    expect(seen[0]).toContain('Batch 1 (2 lines)');
    expect(seen[0]).toContain('line 0');
    expect(seen[1]).toContain('Batch 2');
    expect(subject.batchesProcessed).toBe(2);
  });

  it('carries the skill into the system prompt', async () => {
    let system: string | undefined;
    const subject = analyst(async (args) => {
      system = args.system;
      return { text: 'ok' };
    });
    await subject.ingest(batch());
    expect(system).toContain('ERROR means trouble');
    expect(system).toContain('media/plex');
  });

  it('records a placeholder when the model returns no prose', async () => {
    const messages: unknown[][] = [];
    const subject = analyst(async (args) => {
      messages.push(args.messages);
      return { text: '' };
    });
    await subject.ingest(batch());
    await subject.ingest(batch());
    expect(JSON.stringify(messages[1])).toContain('(no comment)');
  });

  it('compacts once the transcript outgrows the window', async () => {
    let calls = 0;
    const subject = analyst(async () => {
      calls += 1;
      return { text: 'x'.repeat(4000) };
    });

    const big = Array.from({ length: 40 }, (_, i) => ({
      at: null,
      stream: 'stdout' as const,
      text: `noisy ${'y'.repeat(200)} ${i}`,
    }));

    let compacted = false;
    for (let i = 0; i < 8 && !compacted; i += 1) {
      compacted = (await subject.ingest(big)).compacted;
    }

    expect(compacted).toBe(true);
    expect(subject.summary).toBeTruthy();
    expect(calls).toBeGreaterThan(1);
  });
});

describe('ContainerAnalyst.writeDailyReport', () => {
  it('asks for the report with the day and the observation count', async () => {
    let prompt = '';
    const subject = analyst(async (args) => {
      prompt = String(args.messages.at(-1)?.content);
      return { text: '  ## Summary\nA normal day.  ' };
    });

    const report = await subject.writeDailyReport();
    expect(report).toBe('## Summary\nA normal day.');
    expect(prompt).toContain('2026-08-14');
    expect(prompt).toContain('0 observation(s)');
  });

  it('substitutes a placeholder when the model returns nothing', async () => {
    const subject = analyst(async () => ({ text: '  ' }));
    expect(await subject.writeDailyReport()).toContain('no report');
  });
});
