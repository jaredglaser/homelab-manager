import { describe, it, expect, mock } from 'bun:test';
import {
  fetchLogHistory,
  LogHistoryError,
  normalizeLiveLogFrame,
  parseHistoryBody,
  parseHistoryLine,
} from '@/lib/ai/log-source';

describe('parseHistoryLine', () => {
  it('parses a well-formed line', () => {
    expect(parseHistoryLine('{"at":1700,"stream":"stderr","text":"boom"}')).toEqual({
      at: 1700,
      stream: 'stderr',
      text: 'boom',
    });
  });

  it('defaults an unknown stream to stdout and a bad timestamp to null', () => {
    expect(parseHistoryLine('{"at":"nope","stream":"weird","text":"hi"}')).toEqual({
      at: null,
      stream: 'stdout',
      text: 'hi',
    });
  });

  it('rejects malformed JSON, non-objects and missing text', () => {
    expect(parseHistoryLine('not json')).toBeNull();
    expect(parseHistoryLine('null')).toBeNull();
    expect(parseHistoryLine('42')).toBeNull();
    expect(parseHistoryLine('{"stream":"stdout"}')).toBeNull();
  });
});

describe('parseHistoryBody', () => {
  it('drops blank and unparseable lines', () => {
    const body = ['{"at":1,"stream":"stdout","text":"a"}', '', 'garbage', '{"at":2,"stream":"stdout","text":"b"}'].join('\n');
    expect(parseHistoryBody(body).map((line) => line.text)).toEqual(['a', 'b']);
  });
});

describe('fetchLogHistory', () => {
  const signer = async () => 'jwt-token';

  function okResponse(body: string) {
    return new Response(body, { status: 200 });
  }

  it('builds the query and sends the bearer token', async () => {
    const fetchFn = mock(async (_url: string, _init?: RequestInit) => okResponse('{"at":1,"stream":"stdout","text":"a"}\n'));
    const lines = await fetchLogHistory({
      agentUrl: 'http://agent:9090/',
      containerId: 'abc123',
      signer,
      since: new Date(2_000_000),
      until: new Date(5_000_000),
      maxLines: 100,
      fetchFn,
    });

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain('http://agent:9090/logs/abc123/history?');
    expect(url).toContain('sinceSeconds=2000');
    expect(url).toContain('untilSeconds=5000');
    expect(url).toContain('maxLines=100');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer jwt-token');
    expect(lines).toHaveLength(1);
  });

  it('omits the optional parameters when not given', async () => {
    const fetchFn = mock(async (_url: string, _init?: RequestInit) => okResponse(''));
    await fetchLogHistory({
      agentUrl: 'http://agent:9090',
      containerId: 'abc',
      signer,
      since: new Date(0),
      fetchFn,
    });
    const url = fetchFn.mock.calls[0][0];
    expect(url).not.toContain('untilSeconds');
    expect(url).not.toContain('maxLines');
  });

  it('falls back to naive concatenation for an unparseable agent URL', async () => {
    const fetchFn = mock(async (_url: string, _init?: RequestInit) => okResponse(''));
    await fetchLogHistory({
      agentUrl: 'not a url',
      containerId: 'abc',
      signer,
      since: new Date(0),
      fetchFn,
    });
    expect(fetchFn.mock.calls[0][0]).toContain('not a url/logs/abc/history');
  });

  it('rejects a redirect', async () => {
    const fetchFn = mock(async (_url: string, _init?: RequestInit) => new Response(null, { status: 302 }));
    await expect(
      fetchLogHistory({ agentUrl: 'http://a:1', containerId: 'c', signer, since: new Date(0), fetchFn }),
    ).rejects.toBeInstanceOf(LogHistoryError);
  });

  it('rejects a non-ok status', async () => {
    const fetchFn = mock(async (_url: string, _init?: RequestInit) => new Response('nope', { status: 404 }));
    await expect(
      fetchLogHistory({ agentUrl: 'http://a:1', containerId: 'c', signer, since: new Date(0), fetchFn }),
    ).rejects.toThrow('Agent returned 404 for log history');
  });
});

describe('normalizeLiveLogFrame', () => {
  it('splits Docker\'s timestamp prefix off the text', () => {
    expect(normalizeLiveLogFrame({ stream: 'stderr', text: '2026-01-02T03:04:05.000000000Z boom' })).toEqual({
      at: Date.UTC(2026, 0, 2, 3, 4, 5),
      stream: 'stderr',
      text: 'boom',
    });
  });

  it('keeps the whole text when there is no timestamp prefix', () => {
    expect(normalizeLiveLogFrame({ stream: 'stdout', text: 'plain line' })).toEqual({
      at: null,
      stream: 'stdout',
      text: 'plain line',
    });
  });

  it('nulls an unparseable timestamp rather than emitting NaN', () => {
    const result = normalizeLiveLogFrame({ stream: 'stdout', text: '2026-99-99T99:99:99Z broken' });
    expect(result?.at).toBeNull();
    expect(result?.text).toBe('broken');
  });

  it('rejects frames that are not log lines', () => {
    expect(normalizeLiveLogFrame(null)).toBeNull();
    expect(normalizeLiveLogFrame('string')).toBeNull();
    expect(normalizeLiveLogFrame({ stream: 'stdout' })).toBeNull();
  });
});
