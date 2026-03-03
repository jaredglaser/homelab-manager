import { describe, it, expect } from 'bun:test';
import { parseMuxedChunk, parseTtyChunk } from '../docker-log-demux';

describe('parseMuxedChunk', () => {
  function buildFrame(streamType: number, payload: string): Buffer {
    const payloadBuf = Buffer.from(payload, 'utf-8');
    const header = Buffer.alloc(8);
    header[0] = streamType;
    header.writeUInt32BE(payloadBuf.length, 4);
    return Buffer.concat([header, payloadBuf]);
  }

  it('parses a single stdout frame', () => {
    const frame = buildFrame(1, 'hello world\n');
    const { lines, remainder } = parseMuxedChunk(frame);
    expect(lines).toEqual([{ text: 'hello world', stream: 'stdout' }]);
    expect(remainder.length).toBe(0);
  });

  it('parses a single stderr frame', () => {
    const frame = buildFrame(2, 'error occurred\n');
    const { lines, remainder } = parseMuxedChunk(frame);
    expect(lines).toEqual([{ text: 'error occurred', stream: 'stderr' }]);
    expect(remainder.length).toBe(0);
  });

  it('parses multiple frames in one buffer', () => {
    const frame1 = buildFrame(1, 'line1\n');
    const frame2 = buildFrame(2, 'line2\n');
    const combined = Buffer.concat([frame1, frame2]);
    const { lines, remainder } = parseMuxedChunk(combined);
    expect(lines).toEqual([
      { text: 'line1', stream: 'stdout' },
      { text: 'line2', stream: 'stderr' },
    ]);
    expect(remainder.length).toBe(0);
  });

  it('handles multiple lines within a single frame', () => {
    const frame = buildFrame(1, 'first\nsecond\nthird\n');
    const { lines, remainder } = parseMuxedChunk(frame);
    expect(lines).toEqual([
      { text: 'first', stream: 'stdout' },
      { text: 'second', stream: 'stdout' },
      { text: 'third', stream: 'stdout' },
    ]);
    expect(remainder.length).toBe(0);
  });

  it('returns remainder when frame is incomplete', () => {
    const frame = buildFrame(1, 'hello world\n');
    // Truncate the last 3 bytes
    const truncated = frame.subarray(0, frame.length - 3);
    const { lines, remainder } = parseMuxedChunk(truncated);
    expect(lines).toEqual([]);
    expect(remainder.length).toBe(truncated.length);
  });

  it('returns remainder when header is incomplete', () => {
    const partial = Buffer.alloc(5); // Less than 8 bytes for a header
    partial[0] = 1;
    const { lines, remainder } = parseMuxedChunk(partial);
    expect(lines).toEqual([]);
    expect(remainder.length).toBe(5);
  });

  it('handles empty buffer', () => {
    const { lines, remainder } = parseMuxedChunk(Buffer.alloc(0));
    expect(lines).toEqual([]);
    expect(remainder.length).toBe(0);
  });

  it('parses frame without trailing newline', () => {
    const frame = buildFrame(1, 'no newline');
    const { lines, remainder } = parseMuxedChunk(frame);
    expect(lines).toEqual([{ text: 'no newline', stream: 'stdout' }]);
    expect(remainder.length).toBe(0);
  });

  it('handles frame + incomplete frame in same buffer', () => {
    const completeFrame = buildFrame(1, 'complete\n');
    const incompleteFrame = buildFrame(2, 'incomplete data');
    const truncated = incompleteFrame.subarray(0, incompleteFrame.length - 5);
    const combined = Buffer.concat([completeFrame, truncated]);

    const { lines, remainder } = parseMuxedChunk(combined);
    expect(lines).toEqual([{ text: 'complete', stream: 'stdout' }]);
    expect(remainder.length).toBe(truncated.length);
  });

  it('preserves ANSI escape codes', () => {
    const ansiText = '\x1b[31mred text\x1b[0m\n';
    const frame = buildFrame(1, ansiText);
    const { lines } = parseMuxedChunk(frame);
    expect(lines).toEqual([{ text: '\x1b[31mred text\x1b[0m', stream: 'stdout' }]);
  });
});

describe('parseTtyChunk', () => {
  it('parses single line', () => {
    const lines = parseTtyChunk('hello world\n');
    expect(lines).toEqual([{ text: 'hello world', stream: 'stdout' }]);
  });

  it('parses multiple lines', () => {
    const lines = parseTtyChunk('line1\nline2\nline3\n');
    expect(lines).toEqual([
      { text: 'line1', stream: 'stdout' },
      { text: 'line2', stream: 'stdout' },
      { text: 'line3', stream: 'stdout' },
    ]);
  });

  it('handles text without trailing newline', () => {
    const lines = parseTtyChunk('no newline');
    expect(lines).toEqual([{ text: 'no newline', stream: 'stdout' }]);
  });

  it('handles empty string', () => {
    const lines = parseTtyChunk('');
    expect(lines).toEqual([]);
  });

  it('preserves ANSI escape codes', () => {
    const lines = parseTtyChunk('\x1b[32mgreen\x1b[0m\n');
    expect(lines).toEqual([{ text: '\x1b[32mgreen\x1b[0m', stream: 'stdout' }]);
  });

  it('always assigns stdout stream', () => {
    const lines = parseTtyChunk('tty data\n');
    expect(lines.every(l => l.stream === 'stdout')).toBe(true);
  });
});
