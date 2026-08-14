import { describe, it, expect, mock } from 'bun:test';
import type { LanguageModel } from 'ai';
import { EmptyHistoryError, generateContainerSkill, sampleCharBudget } from '@/lib/ai/profiler-agent';
import type { LogLine } from '@/types/ai';

const model = 'fake-model' as unknown as LanguageModel;
const identity = { host: 'nuc', containerKey: 'media/plex', image: 'plex:latest' };

function history(count: number, startAt = 1_700_000_000_000): LogLine[] {
  return Array.from({ length: count }, (_, i) => ({
    at: startAt + i * 1000,
    stream: 'stdout' as const,
    text: `line ${i}`,
  }));
}

describe('sampleCharBudget', () => {
  it('leaves room for the skill the model is about to write', () => {
    expect(sampleCharBudget(32_768)).toBeLessThan(32_768 * 3.5);
    expect(sampleCharBudget(32_768)).toBeGreaterThan(0);
  });
});

describe('generateContainerSkill', () => {
  it('refuses to profile a container with no history', async () => {
    await expect(
      generateContainerSkill({
        identity,
        history: [],
        windowDays: 7,
        model,
        modelId: 'm',
        maxContextTokens: 32_768,
      }),
    ).rejects.toBeInstanceOf(EmptyHistoryError);
  });

  it('returns the skill and the window the sample actually covered', async () => {
    const generate = mock(async (_args: { system?: string; messages: { content: string }[] }) => ({ text: '  ## Format\nstuff  ' }));
    const lines = history(10);
    const result = await generateContainerSkill({
      identity,
      history: lines,
      windowDays: 7,
      model,
      modelId: 'profiler-70b',
      maxContextTokens: 32_768,
      generate: generate as never,
    });

    expect(result.skillMarkdown).toBe('## Format\nstuff');
    expect(result.modelId).toBe('profiler-70b');
    expect(result.sampleLineCount).toBe(10);
    expect(result.sampleStartedAt.getTime()).toBe(lines[0].at!);
    expect(result.sampleEndedAt.getTime()).toBe(lines.at(-1)!.at!);
  });

  it('puts the container and the sample into the prompt', async () => {
    const generate = mock(async (_args: { system?: string; messages: { content: string }[] }) => ({ text: 'skill' }));
    await generateContainerSkill({
      identity,
      history: history(3),
      windowDays: 7,
      model,
      modelId: 'm',
      maxContextTokens: 32_768,
      generate: generate as never,
    });

    const args = generate.mock.calls[0][0];
    expect(args.system).toContain('## Escalation');
    expect(args.messages[0].content).toContain('media/plex');
    expect(args.messages[0].content).toContain('line 0');
  });

  it('down-samples a history that will not fit the context', async () => {
    const generate = mock(async (_args: { system?: string; messages: { content: string }[] }) => ({ text: 'skill' }));
    const result = await generateContainerSkill({
      identity,
      history: history(20_000),
      windowDays: 7,
      model,
      modelId: 'm',
      maxContextTokens: 4_096,
      generate: generate as never,
    });
    expect(result.sampleLineCount).toBeLessThan(20_000);
  });

  it('falls back to the requested window when no line carried a timestamp', async () => {
    const generate = mock(async (_args: { system?: string; messages: { content: string }[] }) => ({ text: 'skill' }));
    const result = await generateContainerSkill({
      identity,
      history: [{ at: null, stream: 'stdout', text: 'no stamp' }],
      windowDays: 2,
      model,
      modelId: 'm',
      maxContextTokens: 32_768,
      generate: generate as never,
    });
    const spanMs = result.sampleEndedAt.getTime() - result.sampleStartedAt.getTime();
    expect(spanMs).toBeGreaterThanOrEqual(2 * 86_400_000 - 1000);
  });

  it('rejects an empty skill rather than storing it', async () => {
    const generate = mock(async (_args: { system?: string; messages: { content: string }[] }) => ({ text: '   ' }));
    await expect(
      generateContainerSkill({
        identity,
        history: history(3),
        windowDays: 7,
        model,
        modelId: 'm',
        maxContextTokens: 32_768,
        generate: generate as never,
      }),
    ).rejects.toThrow('empty skill');
  });
});
