import { describe, it, expect } from 'bun:test';
import {
  zTime,
  zEntityId,
  McpToolError,
  ok,
  fail,
  hasScope,
  iso,
  truncateText,
  parseEntityId,
  resolveWindow,
  encodeCursor,
  decodeCursor,
  MAX_RESULT_BYTES,
} from '@/lib/mcp/shared';

describe('zTime', () => {
  it('accepts a relative duration', () => {
    expect(zTime.safeParse('30m').success).toBe(true);
    expect(zTime.safeParse('7d').success).toBe(true);
  });

  it('accepts an ISO 8601 timestamp', () => {
    expect(zTime.safeParse('2026-08-15T12:00:00Z').success).toBe(true);
  });

  it('rejects garbage', () => {
    expect(zTime.safeParse('not-a-time').success).toBe(false);
  });
});

describe('zEntityId', () => {
  it('accepts host/containerId', () => {
    expect(zEntityId.safeParse('nuc1/9f2c1ab34de5').success).toBe(true);
  });

  it('rejects a value with no slash', () => {
    expect(zEntityId.safeParse('no-slash-here').success).toBe(false);
  });
});

describe('ok', () => {
  it('wraps structured content as text and structuredContent', () => {
    const result = ok({ a: 1 });
    expect(result.content).toEqual([{ type: 'text', text: '{"a":1}' }]);
    expect(result.structuredContent).toEqual({ a: 1 });
  });

  it('throws when the serialized result exceeds the byte cap', () => {
    const big = { text: 'x'.repeat(MAX_RESULT_BYTES + 1) };
    expect(() => ok(big)).toThrow(/exceeds/);
  });
});

describe('fail', () => {
  it('formats the error code and message', () => {
    const result = fail(new McpToolError('unknown_host', 'Unknown host: ghost'));
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('unknown_host: Unknown host: ghost');
  });
});

describe('hasScope', () => {
  it('matches the exact scope', () => {
    expect(hasScope(['mcp:hosts:read'], 'mcp:hosts:read')).toBe(true);
  });

  it('matches via the mcp:read umbrella scope', () => {
    expect(hasScope(['mcp:read'], 'mcp:hosts:read')).toBe(true);
  });

  it('returns false when neither is present', () => {
    expect(hasScope(['mcp:logs:read'], 'mcp:hosts:read')).toBe(false);
  });
});

describe('iso', () => {
  it('formats a Date', () => {
    expect(iso(new Date('2026-08-15T12:00:00.000Z'))).toBe('2026-08-15T12:00:00.000Z');
  });

  it('formats epoch millis', () => {
    expect(iso(0)).toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('truncateText', () => {
  it('leaves short text untouched', () => {
    expect(truncateText('hi', 10)).toEqual({ text: 'hi', truncated: false });
  });

  it('truncates long text', () => {
    expect(truncateText('x'.repeat(20), 5)).toEqual({ text: 'xxxxx', truncated: true });
  });
});

describe('parseEntityId', () => {
  it('splits on the first slash', () => {
    expect(parseEntityId('nuc1/9f2c1ab34de5')).toEqual({ host: 'nuc1', containerId: '9f2c1ab34de5' });
  });
});

describe('resolveWindow', () => {
  it('defaults since/until when neither is given', () => {
    const window = resolveWindow({}, { defaultSinceSeconds: 60, maxSpanSeconds: 3600 });
    expect(window.spanSeconds).toBeCloseTo(60, 0);
  });

  it('resolves relative since/until', () => {
    const window = resolveWindow({ since: '2h', until: '1h' }, { defaultSinceSeconds: 60, maxSpanSeconds: 3600 * 24 });
    expect(window.spanSeconds).toBeCloseTo(3600, 0);
  });

  it('throws invalid_window when since is not before until', () => {
    expect(() => resolveWindow({ since: '1h', until: '2h' }, { defaultSinceSeconds: 60, maxSpanSeconds: 3600 * 24 })).toThrow(
      McpToolError,
    );
  });

  it('throws window_too_large when the span exceeds the cap', () => {
    expect(() => resolveWindow({ since: '10d' }, { defaultSinceSeconds: 60, maxSpanSeconds: 3600 })).toThrow(McpToolError);
  });
});

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a payload', () => {
    const cursor = encodeCursor({ v: 1, after: 'nuc1/abc' });
    expect(decodeCursor<{ v: number; after: string }>(cursor)).toEqual({ v: 1, after: 'nuc1/abc' });
  });

  it('throws invalid_cursor for malformed input', () => {
    expect(() => decodeCursor('not valid base64 json!!')).toThrow(McpToolError);
  });
});
