import { describe, it, expect, mock } from 'bun:test';
import type { ModelMessage } from 'ai';
import { ContextWindow, estimateMessageTokens, estimateTokens } from '@/lib/ai/context-window';

function userTurn(text: string): ModelMessage {
  return { role: 'user', content: text };
}

describe('estimateTokens', () => {
  it('scales with length', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a'.repeat(35))).toBe(10);
  });
});

describe('estimateMessageTokens', () => {
  it('counts string content plus per-message overhead', () => {
    expect(estimateMessageTokens([userTurn('a'.repeat(35))])).toBe(14);
  });

  it('reads text out of structured content parts', () => {
    const message: ModelMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'a'.repeat(35) }],
    };
    expect(estimateMessageTokens([message])).toBe(14);
  });

  it('serializes content parts that carry no text', () => {
    const message = {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'x', toolName: 'y', input: {} }],
    } as unknown as ModelMessage;
    expect(estimateMessageTokens([message])).toBeGreaterThan(4);
  });
});

describe('ContextWindow', () => {
  const summarize = mock(async () => 'compacted');

  it('starts with no summary and returns appended turns verbatim', () => {
    const window = new ContextWindow({ maxTokens: 1000, summarize });
    window.append(userTurn('one'));
    expect(window.summary).toBeNull();
    expect(window.messages()).toEqual([userTurn('one')]);
  });

  it('prepends the summary once one exists', () => {
    const window = new ContextWindow({ maxTokens: 1000, summarize }, 'yesterday was fine');
    window.append(userTurn('one'));
    const messages = window.messages();
    expect(messages).toHaveLength(2);
    expect(String(messages[0].content)).toContain('yesterday was fine');
  });

  it('does not compact while inside the budget', async () => {
    const fn = mock(async () => 'compacted');
    const window = new ContextWindow({ maxTokens: 10_000, summarize: fn });
    window.append(userTurn('short'));
    expect(await window.compactIfNeeded()).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('folds the oldest turns into the summary when over budget', async () => {
    const fn = mock(async (transcript: string) => `summary-of:${transcript.length}`);
    const window = new ContextWindow({ maxTokens: 200, keepRecentTurns: 2, summarize: fn });
    for (let i = 0; i < 8; i += 1) window.append(userTurn('x'.repeat(200)));

    expect(await window.compactIfNeeded()).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(window.compactionCount).toBe(1);
    expect(window.summary?.startsWith('summary-of:')).toBe(true);
    // Summary message plus the two kept turns.
    expect(window.messages()).toHaveLength(3);
  });

  it('passes the previous summary to the next fold', async () => {
    const seen: (string | null)[] = [];
    const fn = mock(async (_transcript: string, previous: string | null) => {
      seen.push(previous);
      return 'next';
    });
    const window = new ContextWindow({ maxTokens: 200, keepRecentTurns: 1, summarize: fn }, 'first');
    for (let i = 0; i < 6; i += 1) window.append(userTurn('x'.repeat(200)));
    await window.compactIfNeeded();
    expect(seen).toEqual(['first']);
  });

  it('refuses to compact when everything left is protected', async () => {
    const fn = mock(async () => 'compacted');
    const window = new ContextWindow({ maxTokens: 1, keepRecentTurns: 4, summarize: fn });
    window.append(userTurn('x'.repeat(500)));
    expect(await window.compactIfNeeded()).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('setSummary replaces the summary and trims it', () => {
    const window = new ContextWindow({ maxTokens: 1000, summarize });
    window.setSummary('  fresh state  ');
    expect(window.summary).toBe('fresh state');
  });

  it('reserves part of the window for the reply', () => {
    const window = new ContextWindow({ maxTokens: 1000, reserveRatio: 0.25, summarize });
    expect(window.budgetTokens).toBe(750);
  });
});
