import { createInterface } from 'readline';
import { Readable } from 'stream';
import type { StreamParser } from '../streaming/types';

/**
 * Generic text line streaming utility
 * Similar to streamToAsyncIterator but for plain text (no JSON parsing)
 *
 * @param stream - Node.js Readable stream
 * @returns AsyncGenerator that yields text lines
 */
export async function* streamTextLines(
  stream: NodeJS.ReadableStream
): AsyncGenerator<string, void, unknown> {
  const rl = createInterface({
    input: stream as Readable,
    terminal: false,
    crlfDelay: Infinity, // Handles both \n and \r\n
  });

  try {
    for await (const line of rl) {
      yield line;
    }
  } finally {
    // Cleanup the stream
    if (stream && 'destroy' in stream) {
      (stream as any).destroy();
    }
  }
}

/**
 * Stream text lines with a parser
 * Applies a StreamParser to each line and yields typed results
 *
 * @param stream - Node.js Readable stream
 * @param parser - Parser that converts lines to typed data
 * @returns AsyncGenerator that yields parsed data
 */
export async function* streamParsedLines<T>(
  stream: NodeJS.ReadableStream,
  parser: StreamParser<T>
): AsyncGenerator<T, void, unknown> {
  let lineNumber = 0;
  const headers: Record<string, unknown> = {};

  for await (const line of streamTextLines(stream)) {
    lineNumber++;

    // Check if we should process this line
    if (parser.shouldProcessLine && !parser.shouldProcessLine(line)) {
      continue;
    }

    // Try to parse header if parser supports it
    if (parser.parseHeader && lineNumber <= 3) {
      const headerData = parser.parseHeader(line);
      if (headerData) {
        Object.assign(headers, headerData);
        continue;
      }
    }

    // Parse the line
    const parsed = parser.parseLine(line, { lineNumber, headers });
    if (parsed !== null) {
      yield parsed;
    }
  }
}
