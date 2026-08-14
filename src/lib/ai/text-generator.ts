import { generateText, type LanguageModel, type ModelMessage, type StopCondition, type ToolSet } from 'ai';

export interface GenerateArgs<TOOLS extends ToolSet> {
  model: LanguageModel;
  system?: string;
  messages: ModelMessage[];
  tools?: TOOLS;
  stopWhen?: StopCondition<TOOLS> | StopCondition<TOOLS>[];
  abortSignal?: AbortSignal;
  maxRetries?: number;
  temperature?: number;
}

/**
 * The single seam every agent in this module calls the model through, so tests
 * substitute a plain function instead of standing up an HTTP endpoint.
 */
export type TextGenerator = <TOOLS extends ToolSet>(
  args: GenerateArgs<TOOLS>,
) => Promise<{ text: string }>;

export const defaultTextGenerator: TextGenerator = (args) => generateText(args);
