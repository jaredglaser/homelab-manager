import { describe, it, expect, spyOn } from 'bun:test';
import {
  BoundedLogBuffer,
  ERROR_LOG_LIMITS,
  MAX_COMPOSE_LINE_CHARS,
  STORED_LOG_LIMITS,
  boundComposeLogs,
  formatOmittedMarker,
  sanitizeComposeLine,
  utf8Length,
} from '../bounded-log-buffer';

const KIB = 1024;
const STORED_TOTAL = STORED_LOG_LIMITS.totalBytes;
const STORED_HEAD = STORED_LOG_LIMITS.headBytes;
const MARKER_PATTERN = /^\[\.\.\. (\d+) lines? \((\d+\.\d) KiB\) omitted \.\.\.\]$/;

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function numberedLines(count: number, width = 100): string[] {
  return Array.from({ length: count }, (_, i) => `${String(i).padStart(7, '0')} ${'x'.repeat(width - 9)}`);
}

function markerOf(logs: string): RegExpExecArray {
  const markers = logs.split('\n').map((line) => MARKER_PATTERN.exec(line)).filter((m) => m !== null);
  expect(markers).toHaveLength(1);
  return markers[0];
}

describe('sanitizeComposeLine', () => {
  it('passes plain compose output through unchanged', () => {
    const line = ' Container plex-app-1  Started\ttab kept, unicode: café 日本語 😀';
    expect(sanitizeComposeLine(line)).toBe(line);
    expect(sanitizeComposeLine('')).toBe('');
  });

  it('strips ANSI CSI sequences', () => {
    expect(sanitizeComposeLine('\u001b[31mred\u001b[0m and \u001b[1;32;4mbold\u001b[m')).toBe('red and bold');
    expect(sanitizeComposeLine('\u001b[2K\u001b[1Gprogress \u001b[?25l')).toBe('progress ');
    expect(sanitizeComposeLine('\u009b31mred\u009b0m')).toBe('red');
  });

  it('strips OSC sequences ended by BEL or ST', () => {
    expect(sanitizeComposeLine('a\u001b]0;window title\u0007b')).toBe('ab');
    expect(sanitizeComposeLine('a\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\b')).toBe('alinkb');
    expect(sanitizeComposeLine('a\u009d0;title\u009cb')).toBe('ab');
  });

  it('removes control characters except tab', () => {
    expect(sanitizeComposeLine('a\u0000b\u0007c\u0008d\u007fe\u0085f\u009fg\th')).toBe('abcdefg\th');
    expect(sanitizeComposeLine('a\rb\nc')).toBe('abc');
  });

  it('removes bidi overrides, embeddings and isolates', () => {
    expect(sanitizeComposeLine('a\u202ab\u202bc\u202cd\u202de\u202ef')).toBe('abcdef');
    expect(sanitizeComposeLine('a\u2066b\u2067c\u2068d\u2069e')).toBe('abcde');
  });

  it('leaves no escape character behind when removal would splice a new sequence together', () => {
    const once = sanitizeComposeLine('\u001b\u001b[31m[1mtext');
    expect(once).not.toContain('\u001b');
    expect(sanitizeComposeLine(once)).toBe(once);
  });

  it('caps a line at 4096 characters', () => {
    expect(sanitizeComposeLine('x'.repeat(MAX_COMPOSE_LINE_CHARS))).toBe('x'.repeat(MAX_COMPOSE_LINE_CHARS));
    expect(sanitizeComposeLine('x'.repeat(MAX_COMPOSE_LINE_CHARS + 1))).toBe('x'.repeat(MAX_COMPOSE_LINE_CHARS));
  });

  it('caps after stripping so escape sequences do not use up the budget', () => {
    expect(sanitizeComposeLine(`\u001b[31m${'x'.repeat(MAX_COMPOSE_LINE_CHARS)}\u001b[0m`)).toBe('x'.repeat(MAX_COMPOSE_LINE_CHARS));
  });

  it('does not cut a surrogate pair at the cap', () => {
    const line = `${'x'.repeat(MAX_COMPOSE_LINE_CHARS - 1)}😀`;
    expect(sanitizeComposeLine(line)).toBe('x'.repeat(MAX_COMPOSE_LINE_CHARS - 1));
    expect(sanitizeComposeLine(`${'x'.repeat(MAX_COMPOSE_LINE_CHARS - 2)}😀`)).toBe(`${'x'.repeat(MAX_COMPOSE_LINE_CHARS - 2)}😀`);
  });

  it('handles a very long line without a terminator for an escape sequence in linear time', () => {
    const line = '\u001b]'.repeat(50_000);
    expect(sanitizeComposeLine(line)).toBe(']'.repeat(MAX_COMPOSE_LINE_CHARS));
  });
});

describe('utf8Length', () => {
  it('matches Buffer.byteLength for ASCII, multi-byte, astral and lone surrogate input', () => {
    for (const sample of ['', 'abc', 'café', '日本', '😀', 'a\ud83dz', '\ude00a', 'x\ud83d']) {
      expect(utf8Length(sample)).toBe(byteLength(sample));
    }
  });
});

describe('formatOmittedMarker', () => {
  it('names the lines and KiB left out', () => {
    expect(formatOmittedMarker(12, 2048)).toBe('[... 12 lines (2.0 KiB) omitted ...]');
    expect(formatOmittedMarker(1, 1536)).toBe('[... 1 line (1.5 KiB) omitted ...]');
    expect(formatOmittedMarker(0, 100)).toBe('[... 0 lines (0.1 KiB) omitted ...]');
    expect(formatOmittedMarker(2, 100)).toBe('[... 2 lines (0.1 KiB) omitted ...]');
  });

  it('stays within the marker reserve at the largest counts', () => {
    const marker = formatOmittedMarker(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    expect(byteLength(`${marker}\n`)).toBeLessThanOrEqual(64);
  });
});

describe('BoundedLogBuffer', () => {
  it('rejects limits with no room for a tail', () => {
    expect(() => new BoundedLogBuffer({ totalBytes: 100, headBytes: 80 })).toThrow(RangeError);
  });

  it('refuses a line after an unterminated one', () => {
    const buffer = new BoundedLogBuffer(STORED_LOG_LIMITS);
    buffer.appendLine('last', false);
    expect(() => buffer.appendLine('more')).toThrow();
  });

  it('returns a log of exactly 256 KiB unchanged', () => {
    const lines = numberedLines(2621, 100);
    const text = `${lines.join('\n')}\n`;
    const padded = `${text}${'p'.repeat(STORED_TOTAL - byteLength(text) - 1)}\n`;
    expect(byteLength(padded)).toBe(STORED_TOTAL);
    expect(boundComposeLogs(padded)).toBe(padded);
  });

  it('returns a log of exactly 256 KiB without a final newline unchanged', () => {
    const text = `${numberedLines(2621, 100).join('\n')}\n`;
    const padded = `${text}${'p'.repeat(STORED_TOTAL - byteLength(text))}`;
    expect(byteLength(padded)).toBe(STORED_TOTAL);
    expect(boundComposeLogs(padded)).toBe(padded);
  });

  it('bounds a log one byte over 256 KiB, omitting whole lines and marking it once', () => {
    const text = `${numberedLines(2621, 100).join('\n')}\n`;
    const finalNewline = 1;
    const over = `${text}${'p'.repeat(STORED_TOTAL + 1 - byteLength(text) - finalNewline)}\n`;
    expect(byteLength(over)).toBe(STORED_TOTAL + 1);
    const bounded = boundComposeLogs(over);
    expect(Number(markerOf(bounded)[1])).toBeGreaterThanOrEqual(1);
    expect(byteLength(bounded)).toBeLessThanOrEqual(STORED_TOTAL);
    expect(bounded.startsWith(over.slice(0, 1000))).toBe(true);
    expect(bounded.endsWith(over.slice(-1000))).toBe(true);
  });

  it('says "1 line" when exactly one line is omitted', () => {
    const buffer = new BoundedLogBuffer({ totalBytes: 1000, headBytes: 10 });
    buffer.appendLine('head');
    for (let i = 0; i < 10; i++) buffer.appendLine(`${i}`.repeat(100));
    const out = buffer.toString();
    expect(out).toMatch(/^head\n\[\.\.\. 1 line \(\d+\.\d KiB\) omitted \.\.\.\]\n/);
    expect(out).not.toContain('1 lines');
  });

  it('keeps the first 32 KiB, the marker and the last 224 KiB of a larger run with exact counts', () => {
    const lines = numberedLines(10_000, 100);
    const original = `${lines.join('\n')}\n`;
    const bounded = boundComposeLogs(original);
    const parts = bounded.split(/^\[\.\.\. .* omitted \.\.\.\]\n/m);
    expect(parts).toHaveLength(2);
    const [head, tail] = parts;
    const [, markerLines, markerKib] = markerOf(bounded);

    expect(original.startsWith(head)).toBe(true);
    expect(original.endsWith(tail)).toBe(true);
    expect(head.endsWith('\n')).toBe(true);
    expect(byteLength(head)).toBeLessThanOrEqual(STORED_HEAD);
    expect(byteLength(head)).toBeGreaterThan(STORED_HEAD - 100);
    expect(byteLength(tail)).toBeLessThanOrEqual(STORED_TOTAL - STORED_HEAD);
    expect(byteLength(tail)).toBeGreaterThan(STORED_TOTAL - STORED_HEAD - 64 - 100);

    const keptLines = head.split('\n').length - 1 + (tail.split('\n').length - 1);
    expect(Number(markerLines)).toBe(10_000 - keptLines);
    const omittedBytes = byteLength(original) - byteLength(head) - byteLength(tail);
    expect(markerKib).toBe((omittedBytes / KIB).toFixed(1));
    expect(byteLength(bounded)).toBeLessThanOrEqual(STORED_TOTAL);
  });

  it('gives a head shorter than 32 KiB spare space to the tail', () => {
    const big = 'b'.repeat(MAX_COMPOSE_LINE_CHARS);
    const lines = [...Array.from({ length: 8 }, () => big), ...Array.from({ length: 6000 }, (_, i) => `tail ${String(i).padStart(5, '0')} ${'t'.repeat(60)}`)];
    const original = `${lines.join('\n')}\n`;
    const bounded = boundComposeLogs(original);
    const [head, tail] = bounded.split(/^\[\.\.\. .* omitted \.\.\.\]\n/m);
    expect(byteLength(head)).toBe(7 * (MAX_COMPOSE_LINE_CHARS + 1));
    expect(byteLength(head)).toBeLessThan(STORED_HEAD);
    expect(byteLength(tail)).toBeGreaterThan(STORED_TOTAL - STORED_HEAD - 64);
    expect(byteLength(tail)).toBeLessThanOrEqual(STORED_TOTAL - byteLength(head) - 64);
    expect(original.endsWith(tail)).toBe(true);
  });

  it('closes the head at the first line that does not fit instead of skipping ahead to a smaller one', () => {
    const buffer = new BoundedLogBuffer({ totalBytes: 1000, headBytes: 100 });
    buffer.appendLine('a'.repeat(60));
    buffer.appendLine('b'.repeat(60));
    buffer.appendLine('c');
    for (let i = 0; i < 300; i++) buffer.appendLine(`line ${i}`);
    const out = buffer.toString();
    expect(out.startsWith(`${'a'.repeat(60)}\n[... `)).toBe(true);
    expect(out).not.toContain('\nc\n');
  });

  it('keeps the end of a single line longer than the whole tail and never cuts a character', () => {
    const buffer = new BoundedLogBuffer({ totalBytes: 400, headBytes: 20 });
    buffer.appendLine('head');
    buffer.appendLine(`start-${'日'.repeat(500)}-end`);
    const out = buffer.toString();
    const [head, tail] = out.split(/^\[\.\.\. .* omitted \.\.\.\]\n/m);
    expect(head).toBe('head\n');
    expect(tail.endsWith('-end\n')).toBe(true);
    expect(tail).not.toContain('start-');
    expect(tail).not.toContain('�');
    expect(byteLength(out)).toBeLessThanOrEqual(400);
    const [, lines] = markerOf(out);
    expect(lines).toBe('0');
  });

  it('keeps whole multi-byte characters at both cut points', () => {
    const line = '日本語😀'.repeat(5);
    const original = `${Array.from({ length: 6000 }, (_, i) => `${String(i).padStart(5, '0')}${line}`).join('\n')}\n`;
    const bounded = boundComposeLogs(original);
    const [head, tail] = bounded.split(/^\[\.\.\. .* omitted \.\.\.\]\n/m);
    expect(bounded).not.toContain('�');
    expect(original.startsWith(head)).toBe(true);
    expect(original.endsWith(tail)).toBe(true);
    expect(Buffer.from(bounded, 'utf8').toString('utf8')).toBe(bounded);
    expect(byteLength(bounded)).toBeLessThanOrEqual(STORED_TOTAL);
  });

  it('counts CRLF as one line break and normalizes it to LF', () => {
    const crlf = `${numberedLines(4000, 100).join('\r\n')}\r\n`;
    const lf = `${numberedLines(4000, 100).join('\n')}\n`;
    expect(boundComposeLogs(crlf)).toBe(boundComposeLogs(lf));
    expect(boundComposeLogs('a\r\nb\r\n')).toBe('a\nb\n');
  });

  it('treats a lone CR as a line break', () => {
    expect(boundComposeLogs('a\rb\rc')).toBe('a\nb\nc');
    const cr = `${numberedLines(4000, 100).join('\r')}\r`;
    const lf = `${numberedLines(4000, 100).join('\n')}\n`;
    expect(boundComposeLogs(cr)).toBe(boundComposeLogs(lf));
  });

  it('returns empty output as empty and keeps blank lines', () => {
    expect(boundComposeLogs('')).toBe('');
    expect(boundComposeLogs('\n')).toBe('\n');
    expect(boundComposeLogs('a\n\nb\n')).toBe('a\n\nb\n');
    expect(boundComposeLogs('a\n\n')).toBe('a\n\n');
  });

  it('does not bound or mark a log that is already bounded', () => {
    const original = `${numberedLines(10_000, 100).join('\n')}\n`;
    const once = boundComposeLogs(original);
    expect(boundComposeLogs(once)).toBe(once);
    expect(once.match(/omitted \.\.\.\]/g)).toHaveLength(1);
  });

  it('does not double-bound at the 16 KiB size either', () => {
    const original = `${numberedLines(1000, 100).join('\n')}\n`;
    const once = boundComposeLogs(original, ERROR_LOG_LIMITS);
    expect(byteLength(once)).toBeLessThanOrEqual(ERROR_LOG_LIMITS.totalBytes);
    expect(boundComposeLogs(once, ERROR_LOG_LIMITS)).toBe(once);
  });

  it('bounds a log of lines at the 4096 character cap with the 16 KiB limit', () => {
    const wide = `${'日'.repeat(MAX_COMPOSE_LINE_CHARS)}\n`;
    const original = wide.repeat(20);
    const bounded = boundComposeLogs(original, ERROR_LOG_LIMITS);
    expect(byteLength(bounded)).toBeLessThanOrEqual(ERROR_LOG_LIMITS.totalBytes);
    expect(bounded).toMatch(/omitted \.\.\.\]\n/);
    expect(bounded.endsWith(wide)).toBe(true);
  });

  it('evicts blank lines without copying the live tail each time', () => {
    const sliceSpy = spyOn(Array.prototype, 'slice');
    let bounded: string;
    let sliceCalls: number;
    try {
      bounded = boundComposeLogs('\n'.repeat(1 << 19));
    } finally {
      sliceCalls = sliceSpy.mock.calls.length;
      sliceSpy.mockRestore();
    }
    expect(sliceCalls).toBeLessThan(50);
    const [head, tail] = bounded.split(/^\[\.\.\. .* omitted \.\.\.\]\n/m);
    expect(head).toBe('\n'.repeat(STORED_HEAD));
    expect(tail.length).toBeGreaterThan(200 * KIB);
    expect(tail).toBe('\n'.repeat(tail.length));
    expect(byteLength(bounded)).toBeLessThanOrEqual(STORED_TOTAL);
  });

  it('bounds a run of many short lines in one pass', () => {
    const original = `${Array.from({ length: 300_000 }, (_, i) => `l${i}`).join('\n')}\n`;
    const bounded = boundComposeLogs(original);
    const [head, tail] = bounded.split(/^\[\.\.\. .* omitted \.\.\.\]\n/m);
    const [, markerLines] = markerOf(bounded);
    const kept = head.split('\n').length - 1 + tail.split('\n').length - 1;
    expect(Number(markerLines) + kept).toBe(300_000);
    expect(tail.endsWith('l299999\n')).toBe(true);
  });

  it('sanitizes lines before bounding them', () => {
    expect(boundComposeLogs('\u001b[32mok\u001b[0m\n\u202eevil\n')).toBe('ok\nevil\n');
    const long = `${'y'.repeat(MAX_COMPOSE_LINE_CHARS + 50)}\n`;
    expect(boundComposeLogs(long)).toBe(`${'y'.repeat(MAX_COMPOSE_LINE_CHARS)}\n`);
  });
});
