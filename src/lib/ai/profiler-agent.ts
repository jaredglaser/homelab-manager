import type { LanguageModel } from 'ai';
import type { LogLine } from '@/types/ai';
import { renderLogBatch, sampleForProfiling } from '@/lib/ai/log-batcher';
import { buildProfilerPrompt, PROFILER_SYSTEM_PROMPT, type ContainerIdentity } from '@/lib/ai/prompts';
import { estimateTokens } from '@/lib/ai/context-window';
import { defaultTextGenerator, type TextGenerator } from '@/lib/ai/text-generator';

export interface ProfilerInput {
  identity: ContainerIdentity;
  /** Full history pulled from the agent, oldest first. */
  history: LogLine[];
  windowDays: number;
  model: LanguageModel;
  modelId: string;
  maxContextTokens: number;
  abortSignal?: AbortSignal;
  generate?: TextGenerator;
}

export interface ProfilerResult {
  skillMarkdown: string;
  modelId: string;
  sampleLineCount: number;
  sampleStartedAt: Date;
  sampleEndedAt: Date;
}

export class EmptyHistoryError extends Error {
  constructor(identity: ContainerIdentity) {
    super(`No log history available for ${identity.host}/${identity.containerKey}`);
    this.name = 'EmptyHistoryError';
  }
}

/**
 * Share of the model's context the profiling sample may occupy. The rest holds
 * the system prompt and the skill the model is about to write, which for a
 * chatty container is itself several thousand tokens.
 */
const SAMPLE_CONTEXT_RATIO = 0.55;
const CHARS_PER_TOKEN = 3.5;

export function sampleCharBudget(maxContextTokens: number): number {
  return Math.floor(maxContextTokens * SAMPLE_CONTEXT_RATIO * CHARS_PER_TOKEN);
}

/** Fallback bounds when Docker gave us lines with no parseable timestamp. */
function windowBounds(history: LogLine[], windowDays: number): { start: Date; end: Date } {
  const stamps = history.map((line) => line.at).filter((at): at is number => at !== null);
  const now = Date.now();
  if (stamps.length === 0) {
    return { start: new Date(now - windowDays * 86_400_000), end: new Date(now) };
  }
  return { start: new Date(Math.min(...stamps)), end: new Date(Math.max(...stamps)) };
}

/**
 * The one-off pass a container gets the first time it is seen: read its
 * history, write the skill every later analysis agent runs on.
 */
export async function generateContainerSkill(input: ProfilerInput): Promise<ProfilerResult> {
  if (input.history.length === 0) throw new EmptyHistoryError(input.identity);

  const sample = sampleForProfiling(input.history, sampleCharBudget(input.maxContextTokens));
  const rendered = renderLogBatch(sample);
  const generate = input.generate ?? defaultTextGenerator;

  const { text } = await generate({
    model: input.model,
    system: PROFILER_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: buildProfilerPrompt(
          input.identity,
          input.windowDays,
          sample.length,
          input.history.length,
          rendered,
        ),
      },
    ],
    abortSignal: input.abortSignal,
    temperature: 0.2,
  });

  const skillMarkdown = text.trim();
  if (skillMarkdown.length === 0) {
    throw new Error(
      `Profiler returned an empty skill for ${input.identity.host}/${input.identity.containerKey}` +
        ` (sample ~${estimateTokens(rendered)} tokens)`,
    );
  }

  const { start, end } = windowBounds(input.history, input.windowDays);
  return {
    skillMarkdown,
    modelId: input.modelId,
    sampleLineCount: sample.length,
    sampleStartedAt: start,
    sampleEndedAt: end,
  };
}
