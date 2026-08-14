import type { LogLine } from '@/types/ai';

export interface LogBatcherOptions {
  maxLines: number;
  /**
   * Character ceiling for a batch. A single chatty container can emit stack
   * traces that blow a line-count budget past the model's context, so whichever
   * limit trips first wins.
   */
  maxChars: number;
  /** Lines longer than this are truncated; a 2 MB JSON blob is not evidence. */
  maxLineChars?: number;
}

const DEFAULT_MAX_LINE_CHARS = 2000;

export function truncateLine(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}… [+${text.length - maxChars} chars truncated]`;
}

/**
 * Accumulates log lines into model-sized batches. Pure and synchronous: the
 * caller decides when to drain on a timer or at day rollover.
 */
export class LogBatcher {
  private buffer: LogLine[] = [];
  private chars = 0;
  private readonly maxLineChars: number;

  constructor(private readonly options: LogBatcherOptions) {
    this.maxLineChars = options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
  }

  get pendingLines(): number {
    return this.buffer.length;
  }

  push(line: LogLine): LogLine[] | null {
    const text = truncateLine(line.text, this.maxLineChars);
    this.buffer.push({ ...line, text });
    this.chars += text.length;
    if (this.buffer.length >= this.options.maxLines || this.chars >= this.options.maxChars) {
      return this.drain();
    }
    return null;
  }

  drain(): LogLine[] | null {
    if (this.buffer.length === 0) return null;
    const batch = this.buffer;
    this.buffer = [];
    this.chars = 0;
    return batch;
  }
}

/** Renders a batch for the model: one line per log line, stderr marked, timestamps ISO. */
export function renderLogBatch(lines: LogLine[]): string {
  return lines
    .map((line) => {
      const stamp = line.at === null ? '--' : new Date(line.at).toISOString();
      const marker = line.stream === 'stderr' ? 'E' : 'O';
      return `${stamp} ${marker} ${line.text}`;
    })
    .join('\n');
}

/**
 * Down-samples a long history to fit a character budget while keeping both ends.
 * The profiler needs to see a week's shape, not a week's volume: the head shows
 * startup and the tail shows current behavior, and a strided middle preserves
 * the variety of formats in between.
 */
export function sampleForProfiling(lines: LogLine[], maxChars: number): LogLine[] {
  const total = lines.reduce((sum, line) => sum + line.text.length + 1, 0);
  if (total <= maxChars || lines.length === 0) return lines;

  const avgChars = Math.max(1, Math.ceil(total / lines.length));
  const budgetLines = Math.max(3, Math.floor(maxChars / avgChars));
  if (budgetLines >= lines.length) return lines;

  const edge = Math.max(1, Math.floor(budgetLines / 4));
  const head = lines.slice(0, edge);
  const tail = lines.slice(-edge);
  const middleBudget = budgetLines - head.length - tail.length;
  if (middleBudget <= 0) return [...head, ...tail];

  const middle = lines.slice(edge, lines.length - edge);
  const stride = Math.max(1, Math.ceil(middle.length / middleBudget));
  const sampled = middle.filter((_, index) => index % stride === 0).slice(0, middleBudget);
  return [...head, ...sampled, ...tail];
}
