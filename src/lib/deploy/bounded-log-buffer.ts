export const STORED_LOG_LIMITS = { totalBytes: 256 * 1024, headBytes: 32 * 1024 } as const;
export const ERROR_LOG_LIMITS = { totalBytes: 16 * 1024, headBytes: 2 * 1024 } as const;
export const MAX_COMPOSE_LINE_CHARS = 4096;

// Longest marker plus its newline: 31 fixed characters, up to 16 digits of lines and 15 of KiB.
const MARKER_RESERVE_BYTES = 64;

const ESC = String.fromCodePoint(0x1b);
const ANSI_SEQUENCE = new RegExp(
  `(?:${ESC}\\[|\\u009b)[0-?]*[ -/]*[@-~]|(?:${ESC}\\]|\\u009d)[^\\u0007${ESC}\\u009c]*(?:\\u0007|${ESC}\\\\|\\u009c)`,
  'g',
);
const STRIPPED_CHARACTERS = /[^\P{Cc}\t]|[\u202A-\u202E\u2066-\u2069]/gu;
const LINE_BREAK = /\r\n|\r|\n/;

export interface BoundedLogLimits {
  totalBytes: number;
  headBytes: number;
}

interface Entry {
  text: string;
  bytes: number;
}

export function sanitizeComposeLine(line: string): string {
  const cleaned = line.replaceAll(ANSI_SEQUENCE, '').replaceAll(STRIPPED_CHARACTERS, '');
  if (cleaned.length <= MAX_COMPOSE_LINE_CHARS) return cleaned;
  const capped = cleaned.slice(0, MAX_COMPOSE_LINE_CHARS);
  return isHighSurrogate(capped.charCodeAt(capped.length - 1)) ? capped.slice(0, -1) : capped;
}

export function formatOmittedMarker(lines: number, bytes: number): string {
  return `[... ${lines} ${lines === 1 ? 'line' : 'lines'} (${(bytes / 1024).toFixed(1)} KiB) omitted ...]`;
}

/** Output is at most `totalBytes` with the marker counted, so bounded output fed back in comes out unchanged and is never marked twice. */
export class BoundedLogBuffer {
  private readonly head: Entry[] = [];
  private headBytes = 0;
  private headClosed = false;
  private tail: Entry[] = [];
  private tailStart = 0;
  private tailBytes = 0;
  private overflowed = false;
  private omittedLines = 0;
  private omittedBytes = 0;
  private unterminated = false;

  constructor(private readonly limits: BoundedLogLimits) {
    if (limits.headBytes < 0 || limits.totalBytes - limits.headBytes <= MARKER_RESERVE_BYTES) {
      throw new RangeError('BoundedLogBuffer needs room for the omitted marker and a tail after the head');
    }
  }

  /** Only the last line of a log may be unterminated, so a log without a final newline keeps its exact size. */
  appendLine(line: string, terminated = true): void {
    if (this.unterminated) throw new Error('Cannot append a line after an unterminated line');
    this.unterminated = !terminated;
    const text = terminated ? `${line}\n` : line;
    const entry = { text, bytes: utf8Length(text) };
    if (!this.headClosed) {
      if (this.headBytes + entry.bytes <= this.limits.headBytes) {
        this.head.push(entry);
        this.headBytes += entry.bytes;
        return;
      }
      this.headClosed = true;
    }
    this.pushTail(entry);
  }

  toString(): string {
    const headText = this.head.map((entry) => entry.text).join('');
    const tailText = this.tail.slice(this.tailStart).map((entry) => entry.text).join('');
    if (!this.overflowed) return headText + tailText;
    return `${headText}${formatOmittedMarker(this.omittedLines, this.omittedBytes)}\n${tailText}`;
  }

  private pushTail(entry: Entry): void {
    this.tail.push(entry);
    this.tailBytes += entry.bytes;
    const room = this.limits.totalBytes - this.headBytes;
    if (!this.overflowed && this.tailBytes <= room) return;
    this.overflowed = true;
    const capacity = room - MARKER_RESERVE_BYTES;
    while (this.tailBytes > capacity) {
      if (this.tail.length - this.tailStart === 1) {
        this.cutLastEntry(capacity);
        return;
      }
      const evicted = this.tail[this.tailStart++];
      this.tailBytes -= evicted.bytes;
      this.omittedLines += 1;
      this.omittedBytes += evicted.bytes;
    }
    if (this.tailStart > 1024 && this.tailStart * 2 > this.tail.length) {
      this.tail = this.tail.slice(this.tailStart);
      this.tailStart = 0;
    }
  }

  private cutLastEntry(capacity: number): void {
    const only = this.tail[this.tailStart];
    const kept = keepLastBytes(only.text, capacity);
    this.omittedBytes += only.bytes - kept.bytes;
    this.tailBytes = kept.bytes;
    this.tail[this.tailStart] = kept;
  }
}

/** Sanitizes and bounds compose output held in memory. Output within the limit comes back with only unsafe characters and line breaks normalized to `\n`. */
export function boundComposeLogs(raw: string, limits: BoundedLogLimits = STORED_LOG_LIMITS): string {
  const lines = raw.split(LINE_BREAK);
  const endsWithBreak = lines[lines.length - 1] === '';
  if (endsWithBreak) lines.pop();
  const buffer = new BoundedLogBuffer(limits);
  const last = lines.length - 1;
  lines.forEach((line, index) => {
    buffer.appendLine(sanitizeComposeLine(line), endsWithBreak || index < last);
  });
  return buffer.toString();
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (isHighSurrogate(code) && i + 1 < text.length && isLowSurrogate(text.charCodeAt(i + 1))) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

function keepLastBytes(text: string, capacity: number): Entry {
  let bytes = 0;
  let start = text.length;
  while (start > 0) {
    const code = text.charCodeAt(start - 1);
    const paired = isLowSurrogate(code) && start > 1 && isHighSurrogate(text.charCodeAt(start - 2));
    const size = paired ? 4 : utf8Length(text[start - 1]);
    if (bytes + size > capacity) break;
    bytes += size;
    start -= paired ? 2 : 1;
  }
  return { text: text.slice(start), bytes };
}
