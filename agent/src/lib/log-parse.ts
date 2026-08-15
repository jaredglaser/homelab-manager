export interface LogLine {
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface MuxedParseResult {
  lines: LogLine[];
  remainder: Buffer;
}

/**
 * Parse a TTY-mode Docker log chunk into individual log lines.
 *
 * In TTY mode Docker multiplexes stdout and stderr into a single stream with no
 * framing headers, so individual lines cannot be attributed to a specific stream
 * and every line is reported as `stdout`.
 */
export function parseTtyChunk(chunk: Buffer): LogLine[] {
  return chunk
    .toString()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((text) => ({ stream: 'stdout' as const, text }));
}

/**
 * Parse a Docker multiplexed log buffer (8-byte headers followed by payloads).
 *
 * Returns any incomplete frame bytes as `remainder` so the caller can prepend
 * them to the next chunk, preventing data loss at chunk boundaries.
 */
export function parseMuxedChunk(chunk: Buffer): MuxedParseResult {
  const lines: LogLine[] = [];
  let offset = 0;

  while (offset + 8 <= chunk.length) {
    const streamType = chunk[offset] === 2 ? 'stderr' : 'stdout';
    const size = chunk.readUInt32BE(offset + 4);

    if (offset + 8 + size > chunk.length) break;

    offset += 8;
    const text = chunk.subarray(offset, offset + size).toString().trimEnd();
    if (text.length > 0) {
      lines.push({ stream: streamType, text });
    }
    offset += size;
  }

  const remainder = offset < chunk.length ? chunk.subarray(offset) : Buffer.alloc(0);
  return { lines, remainder };
}

/**
 * Extract a Docker timestamp from the beginning of a log line.
 *
 * Docker timestamps appear as the first space-delimited token and look like
 * `2026-03-29T12:30:45.123456789Z`.
 */
export function extractTimestamp(text: string): string | null {
  const spaceIdx = text.indexOf(' ');
  if (spaceIdx <= 10) return null;
  const token = text.substring(0, spaceIdx);
  if (token[4] === '-' && token.includes('T')) {
    return token;
  }
  return null;
}

export interface SplitLine {
  at: string | null;
  text: string;
}

/**
 * Split a Docker-timestamped line into its RFC3339Nano token and body.
 *
 * The token is passed through verbatim, never converted to epoch ms or a
 * `Date`: Docker emits nanosecond precision and `Date` truncates to ms, which
 * would collapse ordering between lines emitted inside the same millisecond.
 */
export function splitTimestamp(text: string): SplitLine {
  const token = extractTimestamp(text);
  if (token === null) return { at: null, text };
  return { at: token, text: text.slice(token.length + 1) };
}
