import { describe, it, expect } from 'bun:test';
import { Readable } from 'node:stream';
import type { StreamParser } from '../../streaming/types';
import { streamTextLines, streamParsedLines } from '../text-parser';

function createReadableFromLines(lines: string[]): Readable {
  return Readable.from(lines.join('\n'));
}

describe('streamTextLines', () => {
  it('should yield each line from a readable stream', async () => {
    const stream = createReadableFromLines(['line1', 'line2', 'line3']);
    const result: string[] = [];

    for await (const line of streamTextLines(stream)) {
      result.push(line);
    }

    expect(result).toEqual(['line1', 'line2', 'line3']);
  });

  it('should handle empty stream', async () => {
    const stream = Readable.from('');
    const result: string[] = [];

    for await (const line of streamTextLines(stream)) {
      result.push(line);
    }

    // Empty string produces no lines
    expect(result).toEqual([]);
  });

  it('should handle single line', async () => {
    const stream = createReadableFromLines(['hello world']);
    const result: string[] = [];

    for await (const line of streamTextLines(stream)) {
      result.push(line);
    }

    expect(result).toEqual(['hello world']);
  });

  it('should handle lines with various whitespace', async () => {
    const stream = createReadableFromLines(['  indented', '\ttabbed', 'normal']);
    const result: string[] = [];

    for await (const line of streamTextLines(stream)) {
      result.push(line);
    }

    expect(result).toEqual(['  indented', '\ttabbed', 'normal']);
  });

  it('should handle CRLF line endings', async () => {
    const stream = Readable.from('line1\r\nline2\r\nline3');
    const result: string[] = [];

    for await (const line of streamTextLines(stream)) {
      result.push(line);
    }

    expect(result).toEqual(['line1', 'line2', 'line3']);
  });
});

describe('streamParsedLines', () => {
  it('should apply parser to each line and yield results', async () => {
    const parser: StreamParser<number> = {
      parseLine: (line) => {
        const num = parseInt(line, 10);
        return isNaN(num) ? null : num;
      },
    };

    const stream = createReadableFromLines(['1', '2', '3']);
    const result: number[] = [];

    for await (const value of streamParsedLines(stream, parser)) {
      result.push(value);
    }

    expect(result).toEqual([1, 2, 3]);
  });

  it('should filter lines using shouldProcessLine', async () => {
    const parser: StreamParser<string> = {
      shouldProcessLine: (line) => !line.startsWith('#'),
      parseLine: (line) => line,
    };

    const stream = createReadableFromLines(['# comment', 'data1', '# another comment', 'data2']);
    const result: string[] = [];

    for await (const value of streamParsedLines(stream, parser)) {
      result.push(value);
    }

    expect(result).toEqual(['data1', 'data2']);
  });

  it('should handle headers via parseHeader for first 3 lines', async () => {
    const headers: Record<string, unknown>[] = [];
    const parser: StreamParser<string> = {
      parseHeader: (line) => {
        if (line.startsWith('HEADER:')) {
          return { headerValue: line.slice(7) };
        }
        return undefined;
      },
      parseLine: (line, context) => {
        headers.push({ ...context?.headers });
        return line;
      },
    };

    const stream = createReadableFromLines(['HEADER:test', 'data1', 'data2']);
    const result: string[] = [];

    for await (const value of streamParsedLines(stream, parser)) {
      result.push(value);
    }

    // Header line consumed, data lines parsed with accumulated headers
    expect(result).toEqual(['data1', 'data2']);
    expect(headers[0]).toEqual({ headerValue: 'test' });
  });

  it('should skip null results from parseLine', async () => {
    const parser: StreamParser<string> = {
      parseLine: (line) => (line.length > 3 ? line : null),
    };

    const stream = createReadableFromLines(['ab', 'abcd', 'xy', 'wxyz']);
    const result: string[] = [];

    for await (const value of streamParsedLines(stream, parser)) {
      result.push(value);
    }

    expect(result).toEqual(['abcd', 'wxyz']);
  });

  it('should not call parseHeader after line 3', async () => {
    let headerCallCount = 0;
    const parser: StreamParser<string> = {
      parseHeader: () => {
        headerCallCount++;
        return undefined;
      },
      parseLine: (line) => line,
    };

    const stream = createReadableFromLines(['l1', 'l2', 'l3', 'l4', 'l5']);
    const result: string[] = [];

    for await (const value of streamParsedLines(stream, parser)) {
      result.push(value);
    }

    // parseHeader should only be called for lines 1-3
    expect(headerCallCount).toBe(3);
    expect(result).toEqual(['l1', 'l2', 'l3', 'l4', 'l5']);
  });

  it('should pass lineNumber in context to parseLine', async () => {
    const lineNumbers: number[] = [];
    const parser: StreamParser<string> = {
      parseLine: (line, context) => {
        if (context?.lineNumber) lineNumbers.push(context.lineNumber);
        return line;
      },
    };

    const stream = createReadableFromLines(['a', 'b', 'c']);
    for await (const _ of streamParsedLines(stream, parser)) {
      // consume
    }

    expect(lineNumbers).toEqual([1, 2, 3]);
  });
});
