import { describe, it, expect, spyOn } from 'bun:test';
import type Dockerode from 'dockerode';
import {
  handleLogHistory,
  InvalidHistoryQueryError,
  MAX_HISTORY_LINES,
  parseHistoryQuery,
} from '../routes/logs-history';

/** Docker's multiplexed frame: 8-byte header (stream type + big-endian length) then payload. */
function muxFrame(text: string, stream: 1 | 2 = 1): Buffer {
  const payload = Buffer.from(`${text}\n`);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

interface FakeDockerOptions {
  tty?: boolean;
  buffer?: Buffer;
  inspectError?: Error;
  onLogs?: (options: Record<string, unknown>) => void;
}

function fakeDocker(options: FakeDockerOptions = {}): Dockerode {
  return {
    getContainer: () => ({
      inspect: async () => {
        if (options.inspectError) throw options.inspectError;
        return { Config: { Tty: options.tty ?? false } };
      },
      logs: async (logOptions: Record<string, unknown>) => {
        options.onLogs?.(logOptions);
        return options.buffer ?? Buffer.alloc(0);
      },
    }),
  } as unknown as Dockerode;
}

function url(query = ''): URL {
  return new URL(`http://agent:9090/logs/abc123/history${query}`);
}

async function ndjson(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('parseHistoryQuery', () => {
  it('defaults both bounds and applies the default line cap', () => {
    expect(parseHistoryQuery(new URLSearchParams())).toEqual({
      sinceSeconds: null,
      untilSeconds: null,
      maxLines: 5000,
    });
  });

  it('reads the supplied bounds', () => {
    expect(parseHistoryQuery(new URLSearchParams('sinceSeconds=100&untilSeconds=200&maxLines=10'))).toEqual({
      sinceSeconds: 100,
      untilSeconds: 200,
      maxLines: 10,
    });
  });

  it('clamps maxLines to the hard ceiling', () => {
    expect(parseHistoryQuery(new URLSearchParams('maxLines=999999')).maxLines).toBe(MAX_HISTORY_LINES);
  });

  it('rejects non-numeric and negative values', () => {
    expect(() => parseHistoryQuery(new URLSearchParams('sinceSeconds=yesterday'))).toThrow(
      InvalidHistoryQueryError,
    );
    expect(() => parseHistoryQuery(new URLSearchParams('maxLines=-5'))).toThrow(InvalidHistoryQueryError);
  });

  it('rejects a maxLines that rounds to zero', () => {
    expect(() => parseHistoryQuery(new URLSearchParams('maxLines=0.4'))).toThrow(InvalidHistoryQueryError);
  });

  it('rejects an inverted window', () => {
    expect(() => parseHistoryQuery(new URLSearchParams('sinceSeconds=200&untilSeconds=100'))).toThrow(
      'untilSeconds must not precede sinceSeconds',
    );
  });

  it('treats an empty parameter as absent', () => {
    expect(parseHistoryQuery(new URLSearchParams('sinceSeconds=')).sinceSeconds).toBeNull();
  });
});

describe('handleLogHistory', () => {
  it('rejects a malformed query with 400', async () => {
    const response = await handleLogHistory(fakeDocker(), 'abc123', url('?maxLines=nope'));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid maxLines: 'nope'" });
  });

  it('splits the Docker timestamp into a field and returns NDJSON', async () => {
    const buffer = Buffer.concat([
      muxFrame('2026-08-14T10:00:00.000000000Z started'),
      muxFrame('2026-08-14T10:00:01.000000000Z boom', 2),
    ]);
    const response = await handleLogHistory(fakeDocker({ buffer }), 'abc123', url());

    expect(response.headers.get('Content-Type')).toBe('application/x-ndjson');
    expect(await ndjson(response)).toEqual([
      { at: Date.UTC(2026, 7, 14, 10, 0, 0), stream: 'stdout', text: 'started' },
      { at: Date.UTC(2026, 7, 14, 10, 0, 1), stream: 'stderr', text: 'boom' },
    ]);
  });

  it('nulls the timestamp for a line that carries none', async () => {
    const response = await handleLogHistory(
      fakeDocker({ buffer: muxFrame('no timestamp here') }),
      'abc123',
      url(),
    );
    expect(await ndjson(response)).toEqual([{ at: null, stream: 'stdout', text: 'no timestamp here' }]);
  });

  it('parses a TTY container as a single stdout stream', async () => {
    const buffer = Buffer.from('2026-08-14T10:00:00.000000000Z tty line\n');
    const response = await handleLogHistory(fakeDocker({ tty: true, buffer }), 'abc123', url());
    const lines = await ndjson(response);
    expect(lines).toHaveLength(1);
    expect(lines[0].stream).toBe('stdout');
  });

  it('returns an empty body when the container has no history', async () => {
    const response = await handleLogHistory(fakeDocker(), 'abc123', url());
    expect(await response.text()).toBe('');
  });

  it('passes the window through to Docker and never follows', async () => {
    let seen: Record<string, unknown> | null = null;
    await handleLogHistory(
      fakeDocker({ onLogs: (options) => { seen = options; } }),
      'abc123',
      url('?sinceSeconds=100&untilSeconds=200&maxLines=42'),
    );
    expect(seen).toMatchObject({ follow: false, timestamps: true, tail: 42, since: 100, until: 200 });
  });

  it('omits the bounds Docker was not given', async () => {
    let seen: Record<string, unknown> | null = null;
    await handleLogHistory(
      fakeDocker({ onLogs: (options) => { seen = options; } }),
      'abc123',
      url(),
    );
    expect(seen).not.toHaveProperty('since');
    expect(seen).not.toHaveProperty('until');
  });

  it('trims the parsed lines to maxLines', async () => {
    const buffer = Buffer.concat([muxFrame('one'), muxFrame('two'), muxFrame('three')]);
    const response = await handleLogHistory(fakeDocker({ buffer }), 'abc123', url('?maxLines=2'));
    const lines = await ndjson(response);
    expect(lines.map((line) => line.text)).toEqual(['two', 'three']);
  });

  it('answers 404 when the container is gone', async () => {
    const gone = new Error('No such container: abc123 (HTTP code 404)');
    const response = await handleLogHistory(fakeDocker({ inspectError: gone }), 'abc123', url());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Container not found' });
  });

  it('answers 500 on any other Docker failure', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const response = await handleLogHistory(
      fakeDocker({ inspectError: new Error('socket hung up') }),
      'abc123',
      url(),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'socket hung up' });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
