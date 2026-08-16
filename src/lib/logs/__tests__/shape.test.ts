import { describe, expect, spyOn, test } from 'bun:test';
import {
  MAX_CAPTURED_NUMBERS,
  MAX_SHAPES_PER_ENTITY,
  SHAPE_INPUT_MAX_CHARS,
  SHAPE_NORMALIZER_VERSION,
  SHAPE_PASSES,
  SHAPE_TEMPLATE_MAX_CHARS,
  SIGNIFICANT_JSON_KEYS,
  SUFFIX_INDEX_KEEP,
  coarsenTemplate,
  isPlaceholder,
  literalRatio,
  normalizeLogLine,
  shapeIdForTemplate,
  stripAnsi,
} from '@/lib/logs/shape';

const ESC = String.fromCharCode(0x1b);

function tpl(line: string): string {
  return normalizeLogLine(line).template;
}

describe('normalizeLogLine: one case per pass', () => {
  test('pass 0 ansi: colour codes stripped', () => {
    expect(tpl(`${ESC}[31mERROR${ESC}[0m disk full`)).toBe('ERROR disk full');
  });

  test('pass 0 control: control bytes and trailing CR stripped', () => {
    expect(tpl('line one\r\nline two\x07 bell')).toBe('line one line two bell');
  });

  test('pass 1 url', () => {
    expect(tpl('fetching https://example.com/a/b?x=1 now')).toBe('fetching <URL> now');
  });

  test('pass 2 email', () => {
    expect(tpl('contact admin@example.com for help')).toBe('contact <EMAIL> for help');
  });

  test('pass 3 uuid', () => {
    expect(tpl('id 123e4567-e89b-12d3-a456-426614174000 created')).toBe('id <UUID> created');
  });

  test('pass 4 mac', () => {
    expect(tpl('device aa:bb:cc:dd:ee:ff connected')).toBe('device <MAC> connected');
  });

  test('pass 5 ipv6', () => {
    expect(tpl('connect to ::1 failed')).toBe('connect to <IP6> failed');
    expect(tpl('link-local fe80::1ff:fe23:4567:890a active')).toBe('link-local <IP6> active');
  });

  test('pass 6 ipv4 with cidr', () => {
    expect(tpl('client 192.168.1.5 connected')).toBe('client <IP> connected');
    expect(tpl('subnet 10.0.0.0/24 routed')).toBe('subnet <IP> routed');
  });

  test('pass 7 timestamps: iso, clf, http, syslog, date, epoch, clock', () => {
    expect(tpl('at 2026-08-15T21:04:11Z something')).toBe('at <TS> something');
    expect(tpl('127.0.0.1 - - [15/Aug/2026:21:04:11 +0000] request')).toBe('<IP> - - <TS> request');
    expect(tpl('Date: Sat, 15 Aug 2026 21:04:11 GMT')).toBe('Date: <TS>');
    expect(tpl('Aug 15 21:04:11 host process[123]: msg')).toBe('<TS> host process[<N>]: msg');
    expect(tpl('backup on 2026-08-15 completed')).toBe('backup on <TS> completed');
    expect(tpl('backup on 08/15/2026 completed')).toBe('backup on <TS> completed');
    expect(tpl('epoch 1755289451 recorded')).toBe('epoch <TS> recorded');
    expect(tpl('started at 21:04:11 sharp')).toBe('started at <TS> sharp');
  });

  test('pass 8 durations: iso and go-style', () => {
    expect(tpl('duration PT1H30M elapsed')).toBe('duration <DUR> elapsed');
    expect(tpl('waited 500ms total')).toBe('waited <DUR> total');
    expect(tpl('took 1h2m3s overall')).toBe('took <DUR> overall');
  });

  test('pass 9 paths: windows and unix', () => {
    expect(tpl('opened C:\\Users\\bob\\file.txt now')).toBe('opened <PATH> now');
    expect(tpl('reading /etc/passwd now')).toBe('reading <PATH> now');
    expect(tpl('GET /health 200')).toBe('GET <PATH> 200');
  });

  test('pass 10 quotes: double, backtick, single', () => {
    expect(tpl('saw "hello world" today')).toBe('saw <STR> today');
    expect(tpl('run `ls -la` now')).toBe('run <STR> now');
    expect(tpl("can't open 'foo' now")).toBe("can't open <STR> now");
  });

  test('pass 11 hex and opaque id', () => {
    expect(tpl('Website was defaced today')).toBe('Website was <HEX> today');
    expect(tpl('digest 0xdeadbeef verified')).toBe('digest <HEX> verified');
    expect(tpl('container abc1234567890def started')).toBe('container <HEX> started');
    expect(tpl('request req_9f8a7b6c5d4e3f2a1 accepted')).toBe('request <ID> accepted');
  });

  test('pass 12 suffix index: strips index, keeps known terms', () => {
    expect(tpl('worker-3 started')).toBe('worker-<N> started');
    expect(tpl('thread_47 crashed')).toBe('thread_<N> crashed');
    expect(tpl('shard12 rebalanced')).toBe('shard<N> rebalanced');
    expect(tpl('sha256 checksum ok')).toBe('sha256 checksum ok');
    expect(tpl('using ipv6 stack')).toBe('using ipv6 stack');
    expect(tpl('arm64 build ready')).toBe('arm64 build ready');
  });

  test('pass 13 version', () => {
    expect(tpl('upgraded to v1.2.3 successfully')).toBe('upgraded to <VER> successfully');
    expect(tpl('running 2.10.4-beta.1 build')).toBe('running <VER> build');
  });

  test('pass 14 significance guard: exit codes and http status survive as literals', () => {
    expect(tpl('process exit code 137')).toBe('process exit code 137');
    expect(tpl('process exit code 0')).toBe('process exit code 0');
    expect(tpl('status=500 returned')).toBe('status=500 returned');
    expect(tpl('rc: 2 seen')).toBe('rc: 2 seen');
    expect(tpl('process exited with 137')).toBe('process exited with 137');
    expect(tpl('process terminated with 9')).toBe('process terminated with 9');
  });

  test('pass 15 numbers: negatives, decimals, thousands, exponents', () => {
    expect(tpl('retry 5 times')).toBe('retry <N> times');
    expect(tpl('delta is -12 units')).toBe('delta is <N> units');
    expect(tpl('value 3.14 measured')).toBe('value <N> measured');
    expect(tpl('total 1,234,567 rows')).toBe('total <N> rows');
    expect(tpl('rate 6.02e23 constant')).toBe('rate <N> constant');
    expect(tpl('cpu at 87% now')).toBe('cpu at <N>% now');
  });

  test('pass 16 sentinel strip leaves no residue', () => {
    expect(tpl('exit code 137')).not.toContain(String.fromCharCode(0x01));
  });

  test('pass 17 run collapse: csv and whitespace forms', () => {
    expect(tpl('values: 1, 2, 3, 4')).toBe('values: <N>+');
    expect(tpl('counts 1 2 3 4 done')).toBe('counts <N>+ done');
    expect(tpl('pair 1, 2 stays')).toBe('pair <N>, <N> stays');
  });

  test('pass 18 whitespace fold and trim', () => {
    expect(tpl('a   b     c')).toBe('a b c');
    expect(tpl('  leading and trailing  ')).toBe('leading and trailing');
  });

  test('pass 19 truncate at last space with hash covering truncated form', () => {
    const long = `error ${'word '.repeat(200)}done`;
    const result = normalizeLogLine(long);
    expect(result.template.length).toBeLessThanOrEqual(SHAPE_TEMPLATE_MAX_CHARS + '<TRUNC>'.length);
    expect(result.template.endsWith('<TRUNC>')).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.shapeId).toBe(shapeIdForTemplate(result.template));
  });

  test('pass 19 truncate falls back to a hard cut when no space exists', () => {
    const runOn = 'z'.repeat(700);
    const result = normalizeLogLine(runOn);
    expect(result.truncated).toBe(true);
    expect(result.template).toBe(`${'z'.repeat(SHAPE_TEMPLATE_MAX_CHARS)}<TRUNC>`);
  });
});

describe('order-dependency pairs', () => {
  test('number pass runs after uuid: a uuid is not shredded into digits and hex', () => {
    expect(tpl('id 123e4567-e89b-12d3-a456-426614174000 created')).toBe('id <UUID> created');
  });

  test('number pass runs after ipv4: an address is not split into four numbers', () => {
    expect(tpl('client 192.168.1.5 connected')).toBe('client <IP> connected');
  });

  test('mac pass runs before ipv6: a mac address is not read as an ipv6 fragment', () => {
    expect(tpl('device aa:bb:cc:dd:ee:ff connected')).toBe('device <MAC> connected');
  });

  test('ipv6 pass does not swallow clock times (00:12:33 collision)', () => {
    expect(tpl('ffmpeg: stream 0:1 dropped 47 frames at 00:12:33')).toBe(
      'ffmpeg: stream <N>:<N> dropped <N> frames at <TS>',
    );
  });
});

describe('mandatory named assertions', () => {
  test('defaced collapses to <HEX>', () => {
    expect(tpl('Website was defaced today')).toBe('Website was <HEX> today');
  });

  test("can't open 'foo' does not eat the apostrophe as a quote", () => {
    expect(tpl("can't open 'foo' now")).toBe("can't open <STR> now");
  });

  test('exit code 137 is a different shape from exit code 0', () => {
    const a = normalizeLogLine('process exit code 137');
    const b = normalizeLogLine('process exit code 0');
    expect(a.shapeId).not.toBe(b.shapeId);
    expect(a.template).toBe('process exit code 137');
    expect(b.template).toBe('process exit code 0');
  });

  test('HTTP/1.1 500 keeps the status code literal and differs from a 200', () => {
    const a = normalizeLogLine('served HTTP/1.1 500 with body');
    const b = normalizeLogLine('served HTTP/1.1 200 with body');
    expect(a.template).toContain('500');
    expect(b.template).toContain('200');
    expect(a.shapeId).not.toBe(b.shapeId);
  });

  test('1/2 is not read as a path', () => {
    expect(tpl('ratio 1/2 complete')).toBe('ratio <N>/<N> complete');
  });

  test('stream 0:1 becomes <N>:<N>, not a timestamp', () => {
    expect(tpl('stream 0:1 active')).toBe('stream <N>:<N> active');
  });

  test('a CLF status code outside the quoted request line stays literal and differentiates shapes', () => {
    const ok = normalizeLogLine('127.0.0.1 - - [15/Aug/2026:21:04:11 +0000] "GET /index.html HTTP/1.1" 200 612 "-" "curl/7.68.0"');
    const unauthorized = normalizeLogLine(
      '127.0.0.1 - - [15/Aug/2026:21:04:11 +0000] "GET /index.html HTTP/1.1" 401 612 "-" "curl/7.68.0"',
    );
    const serverError = normalizeLogLine(
      '127.0.0.1 - - [15/Aug/2026:21:04:11 +0000] "GET /index.html HTTP/1.1" 500 612 "-" "curl/7.68.0"',
    );
    expect(ok.template).toBe('<IP> - - <TS> <STR> 200 <N> <STR> <STR>');
    expect(unauthorized.template).toContain('401');
    expect(serverError.template).toContain('500');
    expect(new Set([ok.shapeId, unauthorized.shapeId, serverError.shapeId]).size).toBe(3);
  });

  test('a negative exit code keeps its sign literal instead of splitting into "-" + <N>', () => {
    const a = normalizeLogLine('container exited with -1');
    const b = normalizeLogLine('container exited with -13');
    const c = normalizeLogLine('container exited with 1');
    expect(a.template).toBe('container exited with -1');
    expect(b.template).toBe('container exited with -13');
    expect(a.shapeId).not.toBe(b.shapeId);
    expect(a.shapeId).not.toBe(c.shapeId);
  });

  test('an ipv4-mapped ipv6 address matches whole, not split into <IP6>.<VER>', () => {
    expect(tpl('peer ::ffff:192.168.0.1 connected')).toBe('peer <IP6> connected');
  });
});

describe('JSON fast path', () => {
  test('matches the worked example from the design doc', () => {
    const line = JSON.stringify({
      level: 'error',
      msg: 'connection refused to 10.0.0.5:5432',
      service: 'payments',
      ts: '2026-08-15T21:04:11Z',
    });
    const result = normalizeLogLine(line);
    expect(result.viaJson).toBe(true);
    expect(result.template).toBe('json{level=error,msg=connection refused to <IP>:<N>,service=<STR>,ts=<STR>}');
  });

  test('key order does not affect the resulting shape', () => {
    const a = normalizeLogLine(JSON.stringify({ level: 'error', msg: 'boom' }));
    const b = normalizeLogLine(JSON.stringify({ msg: 'boom', level: 'error' }));
    expect(a.shapeId).toBe(b.shapeId);
    expect(a.template).toBe(b.template);
  });

  test('non-significant keys collapse to generic placeholders by type', () => {
    const line = JSON.stringify({ level: 'info', ok: true, tags: ['a', 'b'], meta: null, misc: 'irrelevant' });
    const result = normalizeLogLine(line);
    expect(result.template).toBe('json{level=info,meta=<NULL>,misc=<STR>,ok=<BOOL>,tags=<ARR>}');
  });

  test('significant object values expand exactly one level, deeper collapses to <OBJ>', () => {
    const line = JSON.stringify({ error: { code: 500, detail: 'x', nested: { a: 1 } }, extra: { a: 1 } });
    const result = normalizeLogLine(line);
    expect(result.template).toBe('json{error={code=500,detail=<STR>,nested=<OBJ>},extra=<OBJ>}');
  });

  test('a significant numeric field keeps its literal value and differentiates shapes', () => {
    const unavailable = normalizeLogLine(JSON.stringify({ level: 'error', msg: 'db down', status: 503 }));
    const ok = normalizeLogLine(JSON.stringify({ level: 'error', msg: 'db down', status: 200 }));
    expect(unavailable.template).toBe('json{level=error,msg=db down,status=503}');
    expect(ok.template).toBe('json{level=error,msg=db down,status=200}');
    expect(unavailable.shapeId).not.toBe(ok.shapeId);
  });

  test('a significant numeric field outside the significance range still collapses to <N>', () => {
    const result = normalizeLogLine(JSON.stringify({ level: 'error', code: 123456789 }));
    expect(result.template).toBe('json{code=<N>,level=error}');
  });

  test('malformed json falls through to the regex pipeline unchanged', () => {
    const line = '{"level":"error", not valid json';
    const result = normalizeLogLine(line);
    expect(result.viaJson).toBe(false);
    expect(result.template).toBe('{<STR>:<STR>, not valid json');
  });

  test('a json array at the top level is not treated as the fast path', () => {
    const line = JSON.stringify([{ level: 'error' }]);
    const result = normalizeLogLine(line);
    expect(result.viaJson).toBe(false);
  });

  test('oversized json body skips the fast path', () => {
    const line = JSON.stringify({ level: 'error', msg: 'x'.repeat(9000) });
    const result = normalizeLogLine(line);
    expect(result.viaJson).toBe(false);
  });
});

describe('shape collapsing: variable parts fold together', () => {
  test('nginx access lines differing only in ip, timestamp and bytes collapse to one shape', () => {
    const a = normalizeLogLine(
      '127.0.0.1 - - [15/Aug/2026:21:04:11 +0000] "GET /index.html HTTP/1.1" 200 612 "-" "curl/7.68.0"',
    );
    const b = normalizeLogLine(
      '10.20.30.40 - - [15/Aug/2026:22:11:02 +0000] "GET /index.html HTTP/1.1" 200 88190 "-" "curl/8.1.0"',
    );
    expect(a.shapeId).toBe(b.shapeId);
  });

  test('postgres statement logs differing only in pid, duration and bound value collapse to one shape', () => {
    const a = normalizeLogLine(
      '2026-08-15 21:04:11.123 UTC [1234] LOG:  duration: 15.234 ms  statement: SELECT * FROM users WHERE id = $1',
    );
    const b = normalizeLogLine(
      '2026-08-15 22:40:02.009 UTC [8821] LOG:  duration: 402.881 ms  statement: SELECT * FROM users WHERE id = $1',
    );
    expect(a.shapeId).toBe(b.shapeId);
  });

  test('java stack frames differing only in line number collapse to one shape', () => {
    const a = normalizeLogLine('\tat com.example.Foo.bar(Foo.java:42)');
    const b = normalizeLogLine('\tat com.example.Foo.bar(Foo.java:917)');
    expect(a.shapeId).toBe(b.shapeId);
    expect(a.template).toBe('at com.example.Foo.bar(Foo.java:<N>)');
  });

  test('ffmpeg progress lines differing only in stream index, frame count and clock collapse to one shape', () => {
    const a = normalizeLogLine('ffmpeg: stream 0:1 dropped 47 frames at 00:12:33');
    const b = normalizeLogLine('ffmpeg: stream 1:2 dropped 903 frames at 01:44:09');
    expect(a.shapeId).toBe(b.shapeId);
  });

  test('go panics differing only in index and length collapse to one shape', () => {
    const a = normalizeLogLine('panic: runtime error: index out of range [5] with length 3');
    const b = normalizeLogLine('panic: runtime error: index out of range [91] with length 200');
    expect(a.shapeId).toBe(b.shapeId);
  });

  test('json structured logs differing only in significant field content but same shape collapse together', () => {
    const a = normalizeLogLine(JSON.stringify({ level: 'error', msg: 'connection refused to 10.0.0.5:5432' }));
    const b = normalizeLogLine(JSON.stringify({ level: 'error', msg: 'connection refused to 172.16.0.9:6379' }));
    expect(a.shapeId).toBe(b.shapeId);
  });

  test('ansi-coloured lines collapse with their plain equivalents', () => {
    const coloured = normalizeLogLine(`${ESC}[32mINFO${ESC}[0m connected to ${ESC}[36m192.168.1.5${ESC}[0m`);
    const plain = normalizeLogLine('INFO connected to 10.1.1.1');
    expect(coloured.shapeId).toBe(plain.shapeId);
  });
});

describe('shape differentiation: different messages do not collapse', () => {
  test('nginx lines with a different http method are distinct shapes', () => {
    const get = normalizeLogLine('Started GET /users');
    const post = normalizeLogLine('Started POST /users');
    expect(get.shapeId).not.toBe(post.shapeId);
  });

  test('postgres statements with a different verb are distinct shapes', () => {
    const select = normalizeLogLine(
      '2026-08-15 21:04:11.123 UTC [1234] LOG:  duration: 15.234 ms  statement: SELECT * FROM users WHERE id = $1',
    );
    const update = normalizeLogLine(
      '2026-08-15 21:04:11.123 UTC [1234] LOG:  duration: 15.234 ms  statement: UPDATE users SET name = $1',
    );
    expect(select.shapeId).not.toBe(update.shapeId);
  });

  test('java exceptions of a different class are distinct shapes', () => {
    const npe = normalizeLogLine('Caused by: java.lang.NullPointerException');
    const aioobe = normalizeLogLine('Caused by: java.lang.ArrayIndexOutOfBoundsException');
    expect(npe.shapeId).not.toBe(aioobe.shapeId);
  });

  test('ffmpeg dropped-frames chatter is distinct from an ffmpeg decode error', () => {
    const chatter = normalizeLogLine('ffmpeg: stream 0:1 dropped 47 frames at 00:12:33');
    const decodeError = normalizeLogLine('ffmpeg: "moov atom not found" error while decoding');
    expect(chatter.shapeId).not.toBe(decodeError.shapeId);
  });

  test('go panics of a different kind are distinct shapes', () => {
    const indexPanic = normalizeLogLine('panic: runtime error: index out of range [5] with length 3');
    const nilPanic = normalizeLogLine('panic: runtime error: invalid memory address or nil pointer dereference');
    expect(indexPanic.shapeId).not.toBe(nilPanic.shapeId);
  });

  test('json logs with a different level are distinct shapes', () => {
    const error = normalizeLogLine(JSON.stringify({ level: 'error', msg: 'connection refused' }));
    const info = normalizeLogLine(JSON.stringify({ level: 'info', msg: 'connection refused' }));
    expect(error.shapeId).not.toBe(info.shapeId);
  });

  test('a level-only difference in free text (case folding) is preserved, not merged', () => {
    const upper = normalizeLogLine('ERROR: disk full');
    const lower = normalizeLogLine('error: disk full');
    expect(upper.shapeId).not.toBe(lower.shapeId);
  });

  test('free text after a level token is not collapsed away (no tail-collapse)', () => {
    const diskFull = normalizeLogLine('ERROR: disk full');
    const linkDown = normalizeLogLine('ERROR: link down');
    expect(diskFull.shapeId).not.toBe(linkDown.shapeId);
  });
});

describe('determinism', () => {
  test('the same input hashes to the same shapeId across 1000 iterations', () => {
    const line = 'ffmpeg: stream 0:1 dropped 47 frames at 00:12:33';
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      ids.add(normalizeLogLine(line).shapeId);
    }
    expect(ids.size).toBe(1);
  });
});

describe('shapeId stability fixture table', () => {
  const fixtures: { line: string; shapeId: string }[] = [
    { line: '127.0.0.1 - - [15/Aug/2026:21:04:11 +0000] "GET /index.html HTTP/1.1" 200 612 "-" "curl/7.68.0"', shapeId: '8378f614d8529ef9' },
    { line: '2026-08-15 21:04:11.123 UTC [1234] LOG:  duration: 15.234 ms  statement: SELECT * FROM users WHERE id = $1', shapeId: '939e864c00f71eb4' },
    { line: '\tat com.example.Foo.bar(Foo.java:42)', shapeId: '9f9f02ead627f310' },
    { line: 'panic: runtime error: index out of range [5] with length 3', shapeId: '67fc4e56dc8c5854' },
    { line: 'ffmpeg: stream 0:1 dropped 47 frames at 00:12:33', shapeId: '04e657fcb4cf49e0' },
    { line: "can't open 'foo' now", shapeId: '1f9ab47318512ff4' },
    { line: 'Website was defaced today', shapeId: '28710f617b1cdf5d' },
    { line: 'process exit code 137', shapeId: '49fe519902b8c17d' },
    { line: 'process exit code 0', shapeId: '8e5c7d3e3acb6073' },
    { line: 'response HTTP/1.1 500 Internal Server Error', shapeId: 'eb4bc37284e96120' },
    { line: 'response HTTP/1.1 200 OK', shapeId: '3460450f4bee4dc7' },
    { line: 'ratio 1/2 complete', shapeId: 'ae807e4a8f7af602' },
    { line: `${ESC}[32mINFO${ESC}[0m connected to ${ESC}[36m192.168.1.5${ESC}[0m`, shapeId: 'b7a7e8b6d34a259d' },
    {
      line: '{"level":"error","msg":"connection refused to 10.0.0.5:5432","service":"payments","ts":"2026-08-15T21:04:11Z"}',
      shapeId: '603acb45391283a7',
    },
    { line: '\tat com.example.Foo.bar(Foo.java:42)', shapeId: '9f9f02ead627f310' },
    { line: 'worker-3 started', shapeId: '7c072945a042a429' },
    { line: 'thread_47 crashed', shapeId: '3ac51c6bad80e289' },
    { line: 'shard12 rebalanced', shapeId: '5101d46db663a07a' },
    { line: 'id 123e4567-e89b-12d3-a456-426614174000 created', shapeId: '64ae16296c8a8bc4' },
    { line: 'device aa:bb:cc:dd:ee:ff connected', shapeId: '41f08add472b1e3c' },
    { line: 'connect to ::1 failed', shapeId: '77e7587e539bcc54' },
    { line: 'client 192.168.1.5 connected', shapeId: '60c9175b967d41c0' },
    { line: 'upgraded to v1.2.3', shapeId: '3bd4a6d76c3dd796' },
    { line: 'waited 500ms', shapeId: 'd1ef186561b64050' },
    { line: 'took 1h2m3s', shapeId: '81aab0b73faf4a2b' },
    { line: 'opened C:\\Users\\bob\\file.txt', shapeId: '1dedceb4ff0e3e9f' },
    { line: 'reading /etc/passwd now', shapeId: '408e7862e68e90ba' },
    { line: 'saw "hello world" today', shapeId: '96dabbea17a29a11' },
    { line: 'run `ls -la` now', shapeId: '17b4e94b3679681e' },
    { line: 'sha256 checksum ok', shapeId: 'c746484b5dd5361b' },
    { line: 'request req_9f8a7b6c5d4e3f2a1 accepted', shapeId: 'b51fe41a1992b62a' },
    { line: 'values: 1, 2, 3, 4', shapeId: '7bc961b425afa818' },
    { line: 'fetching https://example.com/a/b?x=1 now', shapeId: '665aeb3e4c88a6a6' },
    { line: 'contact admin@example.com for help', shapeId: '8b8157d5047bf2fe' },
  ];

  test.each(fixtures)('$line -> $shapeId', ({ line, shapeId }) => {
    expect(normalizeLogLine(line).shapeId).toBe(shapeId);
  });

  test('any regex change must break this table (documents the invalidation lever)', () => {
    expect(SHAPE_NORMALIZER_VERSION).toBe(1);
  });
});

describe('normalizeLogLine: contract edges', () => {
  test('empty string never throws and yields an empty template', () => {
    const result = normalizeLogLine('');
    expect(result.template).toBe('');
    expect(result.tokenCount).toBe(0);
    expect(result.placeholderCount).toBe(0);
    expect(result.shapeId).toBe(shapeIdForTemplate(''));
  });

  test('input longer than SHAPE_INPUT_MAX_CHARS is hard-cut before any pass', () => {
    const huge = 'z'.repeat(5000);
    const result = normalizeLogLine(huge);
    expect(huge.length).toBeGreaterThan(SHAPE_INPUT_MAX_CHARS);
    expect(result.truncated).toBe(true);
  });

  test('tolerates a leading RFC3339 timestamp that slipped through upstream framing', () => {
    const result = normalizeLogLine('2026-08-15T21:04:11.000000000Z container started');
    expect(result.template).toBe('<TS> container started');
  });

  test('never throws on pathological input', () => {
    const weird = `${'\\'.repeat(50)}"${'('.repeat(50)}${'+'.repeat(50)}`;
    expect(() => normalizeLogLine(weird)).not.toThrow();
  });

  test('falls back to a whitespace-folded template when an internal pass throws', () => {
    const spy = spyOn(Buffer, 'byteLength').mockImplementation(() => {
      throw new Error('simulated internal failure');
    });
    try {
      const result = normalizeLogLine('{"level":"error","msg":"boom"}   with   spaces');
      expect(result.viaJson).toBe(false);
      expect(result.template).toBe('{"level":"error","msg":"boom"} with spaces');
      expect(result.shapeId).toBe(shapeIdForTemplate(result.template));
    } finally {
      spy.mockRestore();
    }
  });

  test('numbers are captured in order and capped at MAX_CAPTURED_NUMBERS', () => {
    const many = Array.from({ length: 20 }, (_, i) => `n${i}=${i * 7 + 1}`).join(' ');
    const result = normalizeLogLine(many);
    expect(result.numbers.length).toBe(MAX_CAPTURED_NUMBERS);
    expect(result.numbers[0]).toBe(1);
    expect(result.numbers[1]).toBe(8);
  });

  test('placeholderCount and tokenCount reflect the final template', () => {
    const result = normalizeLogLine('client 192.168.1.5 connected at 21:04:11 with 5 retries');
    expect(result.tokenCount).toBe(result.template.split(/\s+/).filter((t) => t.length > 0).length);
    expect(result.placeholderCount).toBeGreaterThan(0);
    expect(result.placeholderCount).toBeLessThanOrEqual(result.tokenCount);
  });
});

describe('stripAnsi', () => {
  test('removes CSI sequences but leaves plain text untouched', () => {
    expect(stripAnsi(`${ESC}[1;31mBOLD RED${ESC}[0m plain`)).toBe('BOLD RED plain');
  });

  test('removes OSC sequences terminated by BEL', () => {
    const bel = String.fromCharCode(0x07);
    expect(stripAnsi(`${ESC}]0;window title${bel}rest`)).toBe('rest');
  });

  test('is a no-op on text with no escape codes', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });
});

describe('isPlaceholder', () => {
  test('recognizes every closed-set placeholder', () => {
    const placeholders = [
      '<TS>',
      '<DUR>',
      '<UUID>',
      '<IP>',
      '<IP6>',
      '<MAC>',
      '<URL>',
      '<EMAIL>',
      '<PATH>',
      '<HEX>',
      '<ID>',
      '<VER>',
      '<STR>',
      '<N>',
      '<BOOL>',
      '<NULL>',
      '<OBJ>',
      '<ARR>',
    ];
    for (const p of placeholders) {
      expect(isPlaceholder(p)).toBe(true);
      expect(isPlaceholder(`${p}+`)).toBe(true);
    }
  });

  test('rejects non-placeholder tokens, including the truncation marker and compound tokens', () => {
    expect(isPlaceholder('foo')).toBe(false);
    expect(isPlaceholder('<TRUNC>')).toBe(false);
    expect(isPlaceholder('<N>:<N>')).toBe(false);
    expect(isPlaceholder('worker-<N>')).toBe(false);
    expect(isPlaceholder('')).toBe(false);
  });
});

describe('literalRatio', () => {
  test('is 0 for an all-placeholder template', () => {
    expect(literalRatio('<IP> <N> <TS>')).toBe(0);
  });

  test('is 1 for an all-literal template', () => {
    expect(literalRatio('service started cleanly')).toBe(1);
  });

  test('is 0 for the empty template', () => {
    expect(literalRatio('')).toBe(0);
  });

  test('is between 0 and 1 for a mixed template', () => {
    const ratio = literalRatio('connection refused to <IP>');
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(1);
  });
});

describe('coarsenTemplate', () => {
  test('keeps the first four non-placeholder tokens, prefixed with ~', () => {
    expect(coarsenTemplate('ffmpeg: stream <N> dropped <N> frames at <TS>')).toBe('~ffmpeg: stream dropped frames');
  });

  test('respects a custom keepTokens count', () => {
    expect(coarsenTemplate('one two three four five', 2)).toBe('~one two');
  });

  test('handles a template with fewer literal tokens than keepTokens', () => {
    expect(coarsenTemplate('<IP> <N> literal')).toBe('~literal');
  });

  test('handles an all-placeholder template', () => {
    expect(coarsenTemplate('<IP> <N> <TS>')).toBe('~');
  });

  test('masks the value of an embedded key=value token so distinct identifiers coarsen together', () => {
    const alice = coarsenTemplate('user=alice logged in from workstation');
    const bob = coarsenTemplate('user=bob logged in from workstation');
    const carol = coarsenTemplate('user=carol logged in from workstation');
    expect(alice).toBe('~user=* logged in from');
    expect(alice).toBe(bob);
    expect(alice).toBe(carol);
  });
});

describe('shapeIdForTemplate', () => {
  test('is a 16-character lowercase hex string', () => {
    const id = shapeIdForTemplate('some template');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  test('is stable for the same template and differs for a different one', () => {
    expect(shapeIdForTemplate('a')).toBe(shapeIdForTemplate('a'));
    expect(shapeIdForTemplate('a')).not.toBe(shapeIdForTemplate('b'));
  });

  test('normalizeLogLine reuses it so shapeId is always derivable from the template', () => {
    const result = normalizeLogLine('client 192.168.1.5 connected');
    expect(result.shapeId).toBe(shapeIdForTemplate(result.template));
  });
});

describe('SUFFIX_INDEX_KEEP and SIGNIFICANT_JSON_KEYS', () => {
  test('keep set covers the documented technical terms', () => {
    expect(SUFFIX_INDEX_KEEP.has('sha256')).toBe(true);
    expect(SUFFIX_INDEX_KEEP.has('ipv6')).toBe(true);
    expect(SUFFIX_INDEX_KEEP.has('arm64')).toBe(true);
    expect(SUFFIX_INDEX_KEEP.has('worker')).toBe(false);
  });

  test('significant json keys match the documented list', () => {
    expect(SIGNIFICANT_JSON_KEYS).toContain('level');
    expect(SIGNIFICANT_JSON_KEYS).toContain('msg');
    expect(SIGNIFICANT_JSON_KEYS).not.toContain('service');
  });

  test('MAX_SHAPES_PER_ENTITY matches the budget migration 037 cites', () => {
    expect(MAX_SHAPES_PER_ENTITY).toBe(500);
  });
});

describe('SHAPE_PASSES', () => {
  test('is non-empty and every entry has a stable name and a global regex', () => {
    expect(SHAPE_PASSES.length).toBeGreaterThan(20);
    const names = new Set(SHAPE_PASSES.map((p) => p.name));
    expect(names.size).toBe(SHAPE_PASSES.length);
    for (const pass of SHAPE_PASSES) {
      expect(pass.pattern.flags).toContain('g');
    }
  });

  test('replace-based reuse of a global regex is deterministic across repeated calls', () => {
    const urlPass = SHAPE_PASSES.find((p) => p.name === 'url');
    expect(urlPass).toBeDefined();
    const pattern = urlPass?.pattern as RegExp;
    const first = 'go to https://a.example/x now'.replace(pattern, '<URL>');
    const second = 'go to https://a.example/x now'.replace(pattern, '<URL>');
    expect(first).toBe(second);
    expect(pattern.lastIndex).toBe(0);
  });
});
