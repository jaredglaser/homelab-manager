import type { ModelMessage } from 'ai';

/**
 * Chars-per-token ratio used for budgeting. Deliberately pessimistic: log lines
 * are punctuation- and id-heavy, which tokenizes worse than prose, and the cost
 * of over-estimating is one extra compaction rather than a 400 from the endpoint.
 */
const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function messageText(message: ModelMessage): string {
  const { content } = message;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
        return part.text;
      }
      return JSON.stringify(part);
    })
    .join(' ');
}

export function estimateMessageTokens(messages: ModelMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(messageText(message)) + 4, 0);
}

export interface ContextWindowOptions {
  /** Total context the endpoint's model advertises. */
  maxTokens: number;
  /** Share of the window left free for the system prompt, tools, and the reply. */
  reserveRatio?: number;
  /** Turns always kept verbatim, however tight the budget. */
  keepRecentTurns?: number;
  /** Folds dropped turns into prose. Receives the transcript being retired. */
  summarize: (transcript: string, previousSummary: string | null) => Promise<string>;
}

const DEFAULT_RESERVE_RATIO = 0.4;
const DEFAULT_KEEP_RECENT_TURNS = 4;

/**
 * Bounded conversation state for a long-running analysis agent: a rolling
 * prose summary plus the most recent verbatim turns. When the estimate crosses
 * the budget, the oldest turns beyond `keepRecentTurns` are folded into the
 * summary by a model call, so a container that logs all day never grows a
 * transcript the endpoint will refuse.
 */
export class ContextWindow {
  private turns: ModelMessage[] = [];
  private summaryText: string | null;
  private readonly reserveRatio: number;
  private readonly keepRecentTurns: number;
  private compactions = 0;

  constructor(
    private readonly options: ContextWindowOptions,
    initialSummary: string | null = null,
  ) {
    this.summaryText = initialSummary;
    this.reserveRatio = options.reserveRatio ?? DEFAULT_RESERVE_RATIO;
    this.keepRecentTurns = options.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS;
  }

  get summary(): string | null {
    return this.summaryText;
  }

  get compactionCount(): number {
    return this.compactions;
  }

  get budgetTokens(): number {
    return Math.max(1, Math.floor(this.options.maxTokens * (1 - this.reserveRatio)));
  }

  append(message: ModelMessage): void {
    this.turns.push(message);
  }

  /** Messages to send, summary first so the model reads the narrative before the new batch. */
  messages(): ModelMessage[] {
    if (this.summaryText === null) return [...this.turns];
    return [
      { role: 'user', content: `Everything you have concluded so far:\n\n${this.summaryText}` },
      ...this.turns,
    ];
  }

  estimatedTokens(): number {
    return estimateMessageTokens(this.messages());
  }

  async compactIfNeeded(): Promise<boolean> {
    if (this.estimatedTokens() <= this.budgetTokens) return false;
    if (this.turns.length <= this.keepRecentTurns) return false;

    const retiring = this.turns.slice(0, this.turns.length - this.keepRecentTurns);
    const transcript = retiring.map(messageText).join('\n\n');
    const next = await this.options.summarize(transcript, this.summaryText);
    this.summaryText = next.trim();
    this.turns = this.turns.slice(this.turns.length - this.keepRecentTurns);
    this.compactions += 1;
    return true;
  }

  setSummary(summary: string): void {
    this.summaryText = summary.trim();
  }
}
