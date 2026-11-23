import { afterEach, beforeAll, describe, expect, mock, setSystemTime, spyOn, test } from 'bun:test';
import {
  ComposeRun,
  FRAME_OVERHEAD_BYTES,
  TAIL_MAX_BYTES,
  BufferedSink,
  ComposeRunRegistry,
  MAX_LINE_CHARS,
  MAX_STREAMED_BYTES,
  RETAINED_LINES,
  SseSink,
  runBuffered,
  runProcess,
  type ComposeFlow,
  type SpawnFn,
} from '../compose-run';
import { COMPOSE_MAX_FRAME_BYTES, zComposeFrames, zComposeResultFrame, type ComposeFrameEvent } from '../../types/protocol';
import { bounded } from '../test/sse-test-utils';
import { ControlledProcess, backpressuredProcess, finishedProcess, streamOf, unreadableProcess } from '../test/fake-process';

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);

beforeAll(() => {
  console.error = mock(() => undefined);
});

afterEach(() => {
  setSystemTime();
});

interface Delivered {
  stream: string;
  text: string;
  truncated?: true;
}

function collect(maxBytes?: number) {
  const lines: Delivered[] = [];
  const sink = new SseSink((stream, text, truncated) => {
    lines.push({ stream, text, ...(truncated ? { truncated: true as const } : {}) });
  }, maxBytes);
  return { lines, sink, texts: () => lines.map((l) => l.text) };
}

describe('SseSink line splitting', () => {
  test('splits on \\n and emits a final line that has no newline', () => {
    const { sink, texts } = collect();
    sink.write('stdout', bytes('one\ntwo\nthree'));
    sink.end('stdout');
    expect(texts()).toEqual(['one', 'two', 'three']);
  });

  test('does not invent an empty line after a trailing newline', () => {
    const { sink, texts } = collect();
    sink.write('stdout', bytes('one\n'));
    sink.end('stdout');
    expect(texts()).toEqual(['one']);
  });

  test('keeps blank lines in the middle', () => {
    const { sink, texts } = collect();
    sink.write('stdout', bytes('a\n\nb\n'));
    sink.end('stdout');
    expect(texts()).toEqual(['a', '', 'b']);
  });

  test('strips the \\r of a \\r\\n terminator', () => {
    const { sink, texts } = collect();
    sink.write('stdout', bytes('a\r\nb\r\n'));
    sink.end('stdout');
    expect(texts()).toEqual(['a', 'b']);
  });

  test('treats a \\r\\n split across two chunks as one terminator', () => {
    const { sink, texts } = collect();
    sink.write('stdout', bytes('a\r'));
    sink.write('stdout', bytes('\nb\n'));
    sink.end('stdout');
    expect(texts()).toEqual(['a', 'b']);
  });

  test('splits on a lone \\r so progress redraws become separate lines', () => {
    const { sink, texts } = collect();
    sink.write('stdout', bytes('10%\r50%\r100%\n'));
    sink.end('stdout');
    expect(texts()).toEqual(['10%', '50%', '100%']);
  });

  test('a chunk ending in \\r followed by a chunk without \\n starts a new line', () => {
    const { sink, texts } = collect();
    sink.write('stdout', bytes('a\r'));
    sink.write('stdout', bytes('b\n'));
    sink.end('stdout');
    expect(texts()).toEqual(['a', 'b']);
  });

  test('a lone \\r at the very end does not leave a pending line', () => {
    const { sink, texts } = collect();
    sink.write('stdout', bytes('a\r'));
    sink.end('stdout');
    expect(texts()).toEqual(['a']);
  });

  test('joins a line that arrives over several chunks', () => {
    const { sink, texts } = collect();
    sink.write('stdout', bytes('hel'));
    sink.write('stdout', bytes('lo wor'));
    sink.write('stdout', bytes('ld\n'));
    expect(texts()).toEqual(['hello world']);
  });

  test('keeps stdout and stderr partial lines apart and labels each line with its stream', () => {
    const { sink, lines } = collect();
    sink.write('stdout', bytes('out-'));
    sink.write('stderr', bytes('err-'));
    sink.write('stdout', bytes('1\n'));
    sink.write('stderr', bytes('2\n'));
    expect(lines).toEqual([
      { stream: 'stdout', text: 'out-1' },
      { stream: 'stderr', text: 'err-2' },
    ]);
  });

  test('flushes only the stream that ended', () => {
    const { sink, texts } = collect();
    sink.write('stdout', bytes('out'));
    sink.write('stderr', bytes('err'));
    sink.end('stdout');
    expect(texts()).toEqual(['out']);
    sink.end('stderr');
    expect(texts()).toEqual(['out', 'err']);
  });

  test('decodes a multi-byte character split across chunks', () => {
    const { sink, texts } = collect();
    const euro = bytes('€');
    sink.write('stdout', new Uint8Array([...bytes('price '), euro[0]]));
    sink.write('stdout', new Uint8Array([euro[1]]));
    sink.write('stdout', new Uint8Array([euro[2], ...bytes('5\n')]));
    expect(texts()).toEqual(['price €5']);
  });

  test('decodes a four-byte character split over three chunks', () => {
    const { sink, texts } = collect();
    const emoji = bytes('\u{1F600}');
    sink.write('stdout', emoji.slice(0, 1));
    sink.write('stdout', emoji.slice(1, 3));
    sink.write('stdout', new Uint8Array([emoji[3], 10]));
    expect(texts()).toEqual(['\u{1F600}']);
  });

  test('replaces invalid UTF-8 with U+FFFD and flushes a dangling partial character at the end', () => {
    const { sink, texts } = collect();
    sink.write('stdout', new Uint8Array([0x61, 0xff, 0x62, 0x0a, 0xe2, 0x82]));
    sink.end('stdout');
    expect(texts()).toEqual(['a�b', '�']);
  });
});

describe('SseSink line cap', () => {
  test('cuts a longer line to 4096 characters and flags it', () => {
    const { sink, lines } = collect();
    sink.write('stdout', bytes(`${'x'.repeat(5000)}\nnext\n`));
    expect(lines[0].text).toHaveLength(MAX_LINE_CHARS);
    expect(lines[0].truncated).toBe(true);
    expect(lines[1]).toEqual({ stream: 'stdout', text: 'next' });
  });

  test('does not flag a line of exactly 4096 characters', () => {
    const { sink, lines } = collect();
    sink.write('stdout', bytes(`${'x'.repeat(MAX_LINE_CHARS)}\n`));
    expect(lines).toEqual([{ stream: 'stdout', text: 'x'.repeat(MAX_LINE_CHARS) }]);
  });

  test('flags a line cut across chunks and drops the rest of it', () => {
    const { sink, lines } = collect();
    sink.write('stdout', bytes('x'.repeat(3000)));
    sink.write('stdout', bytes('y'.repeat(3000)));
    sink.write('stdout', bytes('z'.repeat(3000)));
    sink.write('stdout', bytes('\nok\n'));
    expect(lines[0].text).toBe('x'.repeat(3000) + 'y'.repeat(MAX_LINE_CHARS - 3000));
    expect(lines[0].truncated).toBe(true);
    expect(lines[1].text).toBe('ok');
  });

  test('flags a final line with no newline that is over the cap', () => {
    const { sink, lines } = collect();
    sink.write('stdout', bytes('x'.repeat(10_000)));
    sink.end('stdout');
    expect(lines).toHaveLength(1);
    expect(lines[0].truncated).toBe(true);
  });

  test('never cuts through a surrogate pair', () => {
    const { sink, lines } = collect();
    sink.write('stdout', bytes(`${'x'.repeat(MAX_LINE_CHARS - 1)}\u{1F600}\n`));
    expect(lines[0].text).toBe('x'.repeat(MAX_LINE_CHARS - 1));
    expect(lines[0].truncated).toBe(true);
  });
});

const frameCost = (text: string) => Buffer.byteLength(JSON.stringify(text)) + FRAME_OVERHEAD_BYTES;
const sseBytes = (event: string, data: unknown) => Buffer.byteLength(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

describe('SseSink byte cap', () => {
  test('charges each line its frame cost, sends lines up to the cap, then counts later lines and their UTF-8 bytes', () => {
    const { sink, texts } = collect(frameCost('1234') + frameCost('5678') + frameCost('90'));
    sink.write('stdout', bytes('1234\n5678\n90\n\u20ac\u20ac\nlast\n'));
    expect(texts()).toEqual(['1234', '5678', '90']);
    expect(sink.droppedLines).toBe(2);
    expect(sink.droppedBytes).toBe(6 + 4);
  });

  test('keeps dropping after the cap even when a later line would have fit', () => {
    const { sink, texts } = collect(frameCost('abcd'));
    sink.write('stdout', bytes('abcd\nefgh\nx\n'));
    expect(texts()).toEqual(['abcd']);
    expect(sink.droppedLines).toBe(2);
  });

  test('empty lines are not free: a flood of them stops at the cap', () => {
    const { sink, lines } = collect();
    const total = 200_000;
    sink.write('stdout', bytes('\n'.repeat(total)));
    let serialized = 0;
    lines.forEach((line, i) => { serialized += sseBytes('line', { seq: i + 1, stream: line.stream, text: line.text }); });

    expect(serialized).toBeLessThanOrEqual(MAX_STREAMED_BYTES);
    expect(lines.length).toBeLessThan(total);
    expect(sink.droppedLines).toBe(total - lines.length);
    expect(sink.droppedLines).toBeGreaterThan(0);
  });

  test('the cost of a line covers its real serialized frame, including JSON escapes and the truncated flag', () => {
    const worst = [
      { text: '', truncated: false },
      { text: '\u0001'.repeat(MAX_LINE_CHARS), truncated: true },
      { text: '"'.repeat(MAX_LINE_CHARS), truncated: true },
    ];
    for (const { text, truncated } of worst) {
      const data = { seq: 99_999_999, stream: 'stderr', text, ...(truncated ? { truncated: true } : {}) };
      expect(sseBytes('line', data)).toBeLessThanOrEqual(frameCost(text));
    }
  });

  test('counts the bytes cut off an overlong line in droppedBytes, sent or not', () => {
    const { sink, lines } = collect();
    sink.write('stdout', bytes(`${'x'.repeat(MAX_LINE_CHARS + 10)}\n`));
    expect(lines[0].truncated).toBe(true);
    expect(sink.droppedBytes).toBe(10);
    expect(sink.droppedLines).toBe(0);
  });

  test('keeps the truncated flag on dropped tail lines and counts their overflow with their text', () => {
    const { sink } = collect(1);
    sink.write('stdout', bytes(`${'y'.repeat(MAX_LINE_CHARS + 5)}\nshort\n`));
    expect(sink.droppedTail).toEqual([
      { stream: 'stdout', text: 'y'.repeat(MAX_LINE_CHARS), truncated: true },
      { stream: 'stdout', text: 'short' },
    ]);
    expect(sink.droppedBytes).toBe(5 + MAX_LINE_CHARS + 5);
  });

  test('keeps the newest tail lines within 32 KiB of serialized bytes and 100 lines', () => {
    const { sink } = collect(1);
    for (let i = 0; i < 300; i++) sink.write('stdout', bytes(`${'\u0001'.repeat(MAX_LINE_CHARS)}\n`));
    sink.write('stdout', bytes('the end\n'));
    expect(Buffer.byteLength(JSON.stringify(sink.droppedTail))).toBeLessThanOrEqual(TAIL_MAX_BYTES);
    expect(sink.droppedTail.at(-1)?.text).toBe('the end');
    expect(sink.droppedTail.length).toBeLessThan(RETAINED_LINES);
  });

  test('a tail whose array JSON would reach 32,769 bytes drops its oldest entry', () => {
    const { sink } = collect(1);
    const base = Buffer.byteLength(JSON.stringify({ stream: 'stdout', text: '' }));
    const entryBytes = 1023;
    for (let i = 0; i < 32; i++) sink.write('stdout', bytes(`${'a'.repeat(entryBytes - base)}\n`));
    expect(sink.droppedTail).toHaveLength(31);
    expect(Buffer.byteLength(JSON.stringify(sink.droppedTail))).toBe(31 * 1024 + 1);
  });

  test('a tail whose array JSON is exactly 32 KiB keeps every entry', () => {
    const { sink } = collect(1);
    const base = Buffer.byteLength(JSON.stringify({ stream: 'stdout', text: '' }));
    const entryBytes = 1056;
    for (let i = 0; i < 31; i++) sink.write('stdout', bytes(`${'a'.repeat(entryBytes - base)}\n`));
    expect(sink.droppedTail).toHaveLength(31);
    expect(Buffer.byteLength(JSON.stringify(sink.droppedTail))).toBe(TAIL_MAX_BYTES);
  });

  test('a capped sink keeps exactly the newest 100 of 150 short lines, and they fit a result frame', () => {
    const { sink } = collect(1);
    for (let i = 0; i < 150; i++) sink.write('stdout', bytes(`line ${i}\n`));

    expect(sink.droppedLines).toBe(150);
    expect(sink.droppedTail).toHaveLength(100);
    expect(sink.droppedTail[0].text).toBe('line 50');
    expect(sink.droppedTail.at(-1)?.text).toBe('line 149');
    const frame = { seq: 1, status: 'failed', exitCode: 1, timedOut: false, droppedLines: sink.droppedLines, droppedBytes: sink.droppedBytes, tail: sink.droppedTail };
    expect(zComposeResultFrame.safeParse(frame).success).toBe(true);
  });

  test('the default cap is 8 MiB', () => {
    expect(MAX_STREAMED_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe('SseSink line cap', () => {
  test('a line of exactly 4096 characters is delivered whole', () => {
    const { lines, sink } = collect();
    sink.write('stdout', bytes(`${'x'.repeat(4096)}\n`));
    expect(lines).toEqual([{ stream: 'stdout', text: 'x'.repeat(4096) }]);
  });

  test('a line of 4097 characters is cut to exactly 4096 and marked truncated', () => {
    const { lines, sink } = collect();
    sink.write('stdout', bytes(`${'x'.repeat(4097)}\n`));
    expect(lines).toEqual([{ stream: 'stdout', text: 'x'.repeat(4096), truncated: true }]);
    expect(sink.droppedBytes).toBe(1);
  });
});

describe('BufferedSink', () => {
  const samples: Record<string, Uint8Array<ArrayBuffer>[]> = {
    empty: [],
    ascii: [bytes('hello\nworld\n')],
    'leading BOM': [new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0a])],
    'invalid bytes': [new Uint8Array([0x61, 0xff, 0xfe, 0x62])],
    'split multi-byte': [new Uint8Array([0xe2, 0x82]), new Uint8Array([0xac, 0x0a])],
    'dangling partial': [new Uint8Array([0x61, 0xe2, 0x82])],
    'split emoji': [new Uint8Array([0xf0, 0x9f]), new Uint8Array([0x98]), new Uint8Array([0x80])],
    'UTF-16LE byte order mark': [new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])],
    'FF FE then ascii in two chunks': [new Uint8Array([0xff, 0xfe, 0x68, 0x65]), bytes('llo\n')],
    'carriage returns': [bytes('a\r\nb\rc\n')],
  };

  for (const [name, chunks] of Object.entries(samples)) {
    test(`produces what Response.text() produced before: ${name}`, async () => {
      const legacy = await new Response(streamOf(...chunks)).text();
      const spawn = (() => finishedProcess({ stdout: chunks, stderr: chunks })) as unknown as SpawnFn;
      const result = await runBuffered(spawn, { cmd: ['x'] }, 1000);
      expect(result.stdout).toBe(legacy);
      expect(result.stderr).toBe(legacy);
    });
  }

  test('matches the previous implementation on a real process with large output, stderr and a failing exit', async () => {
    const spec = {
      cmd: ['sh', '-c', "head -c 3000000 /dev/zero | tr '\\0' 'a'; printf 'caf\\303\\251 warn\\n' >&2; exit 3"],
    };
    const legacy = await (async () => {
      const proc = Bun.spawn({ ...spec, stdout: 'pipe', stderr: 'pipe' });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { exitCode, stdout, stderr, timedOut: false };
    })();

    expect(await runBuffered(Bun.spawn, spec, 1500)).toEqual(legacy);
    expect(legacy.stdout).toHaveLength(3_000_000);
    expect(legacy.exitCode).toBe(3);
  });

  test('a real process printing FF FE first decodes as the previous implementation did', async () => {
    const spec = { cmd: ['sh', '-c', 'printf "\\377\\376hello world\\n"'] };
    const result = await runBuffered(Bun.spawn, spec, 1500);
    expect(result.stdout).toBe('\ufffd\ufffdhello world\n');
  });

  test('keeps the two streams apart', () => {
    const sink = new BufferedSink();
    sink.write('stdout', bytes('out'));
    sink.write('stderr', bytes('err'));
    expect(sink.text('stdout')).toBe('out');
    expect(sink.text('stderr')).toBe('err');
  });
});

describe('runProcess', () => {
  test('keeps draining a stream far past the byte cap so the process can exit', async () => {
    const line = `${'x'.repeat(999)}\n`;
    const chunk = line.repeat(1000);
    const totalLines = 10_500;
    const chunks = Array.from({ length: totalLines / 1000 }, () => chunk).concat([line.repeat(500)]);
    const proc = backpressuredProcess(chunks);

    const registry = new ComposeRunRegistry();
    const run = registry.create('deploy', 'big');
    let sentLines = 0;
    run.subscribe((frame) => { if (frame.event === 'line') sentLines++; });
    const flow: ComposeFlow = async (io) => {
      const result = await io.run({ cmd: ['x'] }, 60_000);
      return { kind: 'finished', phase: 'up', result, timeoutMs: 60_000 };
    };
    run.start(flow, (() => proc) as unknown as SpawnFn);
    const result = await bounded(run.done, 'run.done');

    const perLine = 999;
    const sentExpected = Math.floor(MAX_STREAMED_BYTES / frameCost('x'.repeat(perLine)));
    expect(result.status).toBe('success');
    expect(sentLines).toBe(sentExpected);
    expect(result.droppedLines).toBe(totalLines - sentExpected);
    expect(result.droppedBytes).toBe((totalLines - sentExpected) * perLine);
    expect(result.tail?.length).toBeGreaterThan(0);
    expect(result.tail?.length).toBeLessThanOrEqual(RETAINED_LINES);
    expect(result.tail?.every((l) => l.text === 'x'.repeat(999) && l.stream === 'stdout')).toBe(true);
  });

  test('kills at the deadline and reports it', async () => {
    const proc = new ControlledProcess();
    const sink = new BufferedSink();
    const outcome = await runProcess((() => proc) as unknown as SpawnFn, { cmd: ['x'] }, 5, sink);
    expect(outcome).toEqual({ exitCode: 137, timedOut: true });
    expect(proc.killed).toBe(1);
  });

  test('does not kill a process that finishes in time and clears its timer', async () => {
    const proc = new ControlledProcess();
    const sink = new BufferedSink();
    const pending = runProcess((() => proc) as unknown as SpawnFn, { cmd: ['x'] }, 60_000, sink);
    proc.exit(0);
    expect(await pending).toEqual({ exitCode: 0, timedOut: false });
    expect(proc.killed).toBe(0);
  });

  test('tolerates a process object without kill', async () => {
    let resolveExit!: (code: number) => void;
    const proc = {
      exited: new Promise<number>((resolve) => { resolveExit = resolve; }),
      stdout: streamOf(),
      stderr: streamOf(),
    };
    const pending = runProcess((() => proc) as unknown as SpawnFn, { cmd: ['x'] }, 1, new BufferedSink());
    const timer = setTimeout(() => resolveExit(1), 20);
    expect(await pending).toEqual({ exitCode: 1, timedOut: true });
    clearTimeout(timer);
  });

  test('rejects when the spawn throws', async () => {
    const spawn = (() => { throw new Error('docker: not found'); }) as unknown as SpawnFn;
    const outcome = await runProcess(spawn, { cmd: ['x'] }, 1000, new BufferedSink()).then(() => 'resolved', (error: Error) => error.message);
    expect(outcome).toBe('docker: not found');
  });
});

describe('ComposeRun', () => {
  const spawnOf = (proc: unknown) => (() => proc) as unknown as SpawnFn;

  function singleProcessFlow(timeoutMs = 60_000): ComposeFlow {
    return async (io) => {
      io.phase('up', timeoutMs);
      const result = await io.run({ cmd: ['x'] }, timeoutMs);
      return { kind: 'finished', phase: 'up', result, timeoutMs };
    };
  }

  function record(run: ReturnType<ComposeRunRegistry['create']>) {
    const frames: ComposeFrameEvent[] = [];
    run.subscribe((frame) => frames.push(frame));
    return frames;
  }

  test('numbers phase, line and result frames from 1 with no gaps, and every frame parses', async () => {
    const run = new ComposeRunRegistry().create('deploy', 'app');
    const frames = record(run);
    run.start(singleProcessFlow(), spawnOf(finishedProcess({ stdout: ['a\nb\n'], stderr: ['warn\n'] })));
    await bounded(run.done, 'run.done');

    expect(frames.map((f) => f.event)).toEqual(['phase', 'line', 'line', 'line', 'result']);
    expect(frames.map((f) => f.data.seq)).toEqual([1, 2, 3, 4, 5]);
    for (const frame of frames) {
      expect(zComposeFrames[frame.event as keyof typeof zComposeFrames].safeParse(frame.data).success).toBe(true);
    }
  });

  test('a clean exit is a success result with no failedPhase', async () => {
    const run = new ComposeRunRegistry().create('deploy', 'app');
    run.start(singleProcessFlow(), spawnOf(finishedProcess()));
    expect(await bounded(run.done, 'run.done')).toEqual({
      seq: 2,
      status: 'success',
      exitCode: 0,
      timedOut: false,
      droppedLines: 0,
      droppedBytes: 0,
    });
  });

  test('a non-zero exit is failed with the exit code and the failing phase', async () => {
    const run = new ComposeRunRegistry().create('deploy', 'app');
    run.start(singleProcessFlow(), spawnOf(finishedProcess({ exitCode: 17 })));
    expect(await bounded(run.done, 'run.done')).toMatchObject({ status: 'failed', exitCode: 17, timedOut: false, failedPhase: 'up' });
  });

  test('a timeout is failed with timedOut and the budget', async () => {
    const run = new ComposeRunRegistry().create('deploy', 'app');
    run.start(singleProcessFlow(5), spawnOf(new ControlledProcess()));
    expect(await bounded(run.done, 'run.done')).toMatchObject({ status: 'failed', exitCode: 137, timedOut: true, timeoutMs: 5, failedPhase: 'up' });
  });

  test('a spawn failure is failed with a null exit code and the spawn code', async () => {
    const run = new ComposeRunRegistry().create('deploy', 'app');
    const spawn = (() => { throw new Error('docker: not found'); }) as unknown as SpawnFn;
    run.start(async (io) => {
      io.phase('up', 1000);
      try {
        await io.run({ cmd: ['x'] }, 1000);
      } catch (error) {
        return { kind: 'spawn_failed', phase: 'up', error };
      }
      throw new Error('unreachable');
    }, spawn);
    expect(await bounded(run.done, 'run.done')).toMatchObject({
      status: 'failed',
      exitCode: null,
      timedOut: false,
      failedPhase: 'up',
      code: 'compose_spawn_failed',
      detail: 'docker: not found',
    });
  });

  test('an exception out of the flow still ends the run with a failed result', async () => {
    const run = new ComposeRunRegistry().create('deploy', 'app');
    run.start((io) => {
      io.phase('pull', 1000);
      return Promise.reject(new Error('boom'));
    }, spawnOf(finishedProcess()));
    expect(await bounded(run.done, 'run.done')).toMatchObject({ status: 'failed', exitCode: null, failedPhase: 'pull', code: 'compose_spawn_failed', detail: 'boom' });
  });

  test('a throwing subscriber does not stop the run or the other subscribers', async () => {
    const run = new ComposeRunRegistry().create('deploy', 'app');
    run.subscribe(() => { throw new Error('subscriber bug'); });
    const frames = record(run);
    run.start(singleProcessFlow(), spawnOf(finishedProcess({ stdout: ['a\n'] })));
    await bounded(run.done, 'run.done');
    expect(frames.map((f) => f.event)).toEqual(['phase', 'line', 'result']);
  });

  test('an unsubscribed listener hears nothing more and the run carries on', async () => {
    const run = new ComposeRunRegistry().create('deploy', 'app');
    const proc = new ControlledProcess();
    const heard: string[] = [];
    let heardFirstLine!: () => void;
    const firstLine = new Promise<void>((resolve) => { heardFirstLine = resolve; });
    const unsubscribe = run.subscribe((frame) => {
      heard.push(frame.event);
      if (frame.event === 'line') heardFirstLine();
    });
    run.start(singleProcessFlow(), spawnOf(proc));
    proc.write('stdout', 'first\n');
    await firstLine;
    unsubscribe();
    proc.write('stdout', 'second\n');
    proc.exit(0);
    const result = await bounded(run.done, 'run.done');

    expect(result.status).toBe('success');
    expect(proc.killed).toBe(0);
    expect(heard).toEqual(['phase', 'line']);
  });

  test('retains only the last lines it sent', async () => {
    const run = new ComposeRunRegistry().create('deploy', 'app');
    const lines = Array.from({ length: RETAINED_LINES + 25 }, (_, i) => `line ${i}\n`).join('');
    run.start(singleProcessFlow(), spawnOf(finishedProcess({ stdout: [lines] })));
    await bounded(run.done, 'run.done');

    expect(run.lastLines).toHaveLength(RETAINED_LINES);
    expect(run.lastLines[0].text).toBe('line 25');
    expect(run.lastLines.at(-1)?.text).toBe(`line ${RETAINED_LINES + 24}`);
  });

  test('keeps quiet-run output out of the log', async () => {
    const run = new ComposeRunRegistry().create('deploy', 'app');
    const frames = record(run);
    const outputs = ['SECRET=value\n', 'Started\n'];
    run.start(async (io) => {
      const quiet = await io.runQuiet({ cmd: ['x'] }, 1000);
      expect(quiet.stdout).toBe('SECRET=value\n');
      io.phase('up', 1000);
      const result = await io.run({ cmd: ['x'] }, 1000);
      return { kind: 'finished', phase: 'up', result, timeoutMs: 1000 };
    }, (() => finishedProcess({ stdout: [outputs.shift()!] })) as unknown as SpawnFn);
    await bounded(run.done, 'run.done');
    const texts = frames.flatMap((f) => (f.event === 'line' ? [f.data.text] : []));
    expect(texts).toEqual(['Started']);
  });
});

describe('ComposeRunRegistry', () => {
  const MINUTE = 60_000;

  function finish(run: ReturnType<ComposeRunRegistry['create']>) {
    run.start(() => Promise.resolve({
      kind: 'finished',
      phase: 'up',
      result: { exitCode: 0, stdout: '', stderr: '', timedOut: false },
      timeoutMs: 1,
    }), (() => finishedProcess()) as unknown as SpawnFn);
    return bounded(run.done, 'run.done');
  }

  test('keeps a finished run, with its result and lines, until ten minutes after it finished', async () => {
    let now = 1_000_000;
    const registry = new ComposeRunRegistry({ now: () => now });
    const run = registry.create('deploy', 'app');
    run.start(async (io) => {
      const result = await io.run({ cmd: ['x'] }, 1000);
      return { kind: 'finished', phase: 'up', result, timeoutMs: 1000 };
    }, (() => finishedProcess({ stdout: ['kept\n'] })) as unknown as SpawnFn);
    await bounded(run.done, 'run.done');

    now += 10 * MINUTE - 1;
    const found = registry.get(run.runId);
    expect(found?.result?.status).toBe('success');
    expect(found?.lastLines.map((l) => l.text)).toEqual(['kept']);

    now += 1;
    expect(registry.get(run.runId)).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  test('never expires a run that is still going', () => {
    let now = 0;
    const registry = new ComposeRunRegistry({ now: () => now });
    const run = registry.create('deploy', 'app');
    now += 60 * MINUTE;
    expect(registry.get(run.runId)).toBe(run);
  });

  test('counts retention from the finish, not from the start', async () => {
    let now = 0;
    const registry = new ComposeRunRegistry({ now: () => now });
    const run = registry.create('deploy', 'app');
    now += 30 * MINUTE;
    await finish(run);
    now += 9 * MINUTE;
    expect(registry.get(run.runId)).toBe(run);
  });

  test('keeps at most 20 runs by dropping the oldest finished ones first', async () => {
    const registry = new ComposeRunRegistry();
    const runs = Array.from({ length: 25 }, (_, i) => registry.create('deploy', `stack${i}`));
    expect(registry.size).toBe(25);

    for (const run of runs) await finish(run);

    expect(registry.size).toBe(20);
    expect(registry.get(runs[4].runId)).toBeUndefined();
    expect(registry.get(runs[5].runId)).toBe(runs[5]);
    expect(registry.get(runs[24].runId)).toBe(runs[24]);
  });

  test('never evicts a running run to make room', async () => {
    const registry = new ComposeRunRegistry({ maxRuns: 2 });
    const running = registry.create('deploy', 'a');
    const done = registry.create('deploy', 'b');
    await finish(done);
    const third = registry.create('deploy', 'c');

    expect(registry.get(done.runId)).toBeUndefined();
    expect(registry.get(running.runId)).toBe(running);
    expect(registry.get(third.runId)).toBe(third);
  });

  test('follows the system clock by default', async () => {
    setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const registry = new ComposeRunRegistry();
    const run = registry.create('deploy', 'app');
    await finish(run);

    setSystemTime(new Date('2026-01-01T00:09:59Z'));
    expect(registry.get(run.runId)).toBe(run);
    setSystemTime(new Date('2026-01-01T00:10:00Z'));
    expect(registry.get(run.runId)).toBeUndefined();
  });

  test('gives every run its own id', () => {
    const registry = new ComposeRunRegistry();
    expect(registry.create('deploy', 'a').runId).not.toBe(registry.create('deploy', 'a').runId);
  });
});

describe('capped run tail', () => {
  const lineOf = (text: string) => `${text}\n`;
  const spawnOf = (proc: unknown) => (() => proc) as unknown as SpawnFn;

  test('a capped failing run delivers its last lines in the result frame', async () => {
    const filler = 'f'.repeat(999);
    const chunks = [lineOf(filler).repeat(9000), 'late line\n', 'ERROR: final failure\n'];
    const run = new ComposeRunRegistry().create('deploy', 'big');
    run.start(async (io) => {
      const result = await io.run({ cmd: ['x'] }, 60_000);
      return { kind: 'finished', phase: 'up', result, timeoutMs: 60_000 };
    }, spawnOf({ ...backpressuredProcess(chunks, 1) }));
    const result = await bounded(run.done, 'run.done');

    expect(result.status).toBe('failed');
    expect(result.droppedLines).toBeGreaterThan(0);
    expect(result.tail?.at(-1)).toEqual({ stream: 'stdout', text: 'ERROR: final failure' });
    expect(result.tail?.at(-2)).toEqual({ stream: 'stdout', text: 'late line' });
    expect(zComposeFrames.result.safeParse(result).success).toBe(true);
  });

  test('omits tail when nothing was dropped', async () => {
    const run = new ComposeRunRegistry().create('deploy', 'small');
    run.start(async (io) => {
      const result = await io.run({ cmd: ['x'] }, 1000);
      return { kind: 'finished', phase: 'up', result, timeoutMs: 1000 };
    }, spawnOf(finishedProcess({ stdout: ['a\n'] })));
    expect('tail' in (await bounded(run.done, 'run.done'))).toBe(false);
  });
});

describe('frame size bound', () => {
  test('a capped run of worst-case lines keeps every frame, result included, under the manager frame limit', async () => {
    const line = `${'\u0001'.repeat(MAX_LINE_CHARS + 50)}\n`;
    const proc = backpressuredProcess(Array.from({ length: 600 }, () => line), 1);
    const run = new ComposeRunRegistry().create('deploy', 'worst');
    let largest = 0;
    run.subscribe((frame) => {
      largest = Math.max(largest, Buffer.byteLength(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`));
    });
    run.start(async (io) => {
      const result = await io.run({ cmd: ['x'] }, 60_000);
      return { kind: 'finished', phase: 'up', result: { ...result, readError: 'R'.repeat(2000) }, timeoutMs: 60_000 };
    }, (() => proc) as unknown as SpawnFn);
    const result = await bounded(run.done, 'run.done');

    expect(result.droppedLines).toBeGreaterThan(0);
    expect(result.tail?.length).toBeGreaterThan(0);
    expect(result.tail?.every((l) => l.truncated === true)).toBe(true);
    const resultBytes = Buffer.byteLength(`event: result\ndata: ${JSON.stringify(result)}\n\n`);
    expect(resultBytes).toBeLessThan(COMPOSE_MAX_FRAME_BYTES);
    expect(largest).toBeLessThan(COMPOSE_MAX_FRAME_BYTES);
    expect(largest).toBeGreaterThan(resultBytes - 1);
  });

  test('the manager frame limit is 64 KiB', () => {
    expect(COMPOSE_MAX_FRAME_BYTES).toBe(64 * 1024);
  });
});

describe('runProcess fault handling', () => {
  const limits = { killGraceMs: 10, drainGraceMs: 10 };
  const spawnOf = (proc: unknown) => (() => proc) as unknown as SpawnFn;

  function stubborn(opts: { exitsOn?: 'sigkill' | 'never' } = {}) {
    const signals: (number | string | undefined)[] = [];
    let resolveExit!: (code: number) => void;
    const stdout = new ReadableStream<Uint8Array<ArrayBuffer>>();
    const stderr = new ReadableStream<Uint8Array<ArrayBuffer>>();
    const proc = {
      exited: new Promise<number>((resolve) => { resolveExit = resolve; }),
      stdout,
      stderr,
      kill: (signal?: number | string) => {
        signals.push(signal);
        if (signal === 9 && opts.exitsOn === 'sigkill') resolveExit(137);
      },
    };
    return { proc, signals };
  }

  test('escalates to SIGKILL when the process ignores SIGTERM at the deadline', async () => {
    const { proc, signals } = stubborn({ exitsOn: 'sigkill' });
    const outcome = await runProcess(spawnOf(proc), { cmd: ['x'] }, 5, new BufferedSink(), limits);
    expect(signals).toEqual([undefined, 9]);
    expect(outcome).toEqual({ exitCode: 137, timedOut: true, readError: undefined, outputIncomplete: true });
  });

  test('SIGKILL follows SIGTERM after exactly 5000 ms by default', async () => {
    const real = globalThis.setTimeout;
    const delays: (number | undefined)[] = [];
    const timers = spyOn(globalThis, 'setTimeout').mockImplementation(
      ((fn: () => void, delay?: number) => {
        delays.push(delay);
        return real(fn, delay !== undefined && delay >= 1000 ? 1 : delay);
      }) as unknown as typeof setTimeout,
    );
    let signals: (number | string | undefined)[];
    try {
      const stub = stubborn({ exitsOn: 'sigkill' });
      signals = stub.signals;
      await runProcess(spawnOf(stub.proc), { cmd: ['x'] }, 5, new BufferedSink());
    } finally {
      timers.mockRestore();
    }
    expect(delays.slice(0, 2)).toEqual([5, 5000]);
    expect(signals).toEqual([undefined, 9]);
  });

  test('settles with no exit code when the process survives SIGKILL and the pipes never close', async () => {
    const { proc, signals } = stubborn({ exitsOn: 'never' });
    const outcome = await runProcess(spawnOf(proc), { cmd: ['x'] }, 5, new BufferedSink(), limits);
    expect(signals).toEqual([undefined, 9]);
    expect(outcome).toMatchObject({ exitCode: null, timedOut: true });
  });

  test('stops waiting on a pipe a leftover child holds open after the process exits', async () => {
    const proc = new ControlledProcess();
    const sink = new BufferedSink();
    const pending = runProcess(spawnOf({
      exited: proc.exited,
      stdout: new ReadableStream<Uint8Array<ArrayBuffer>>(),
      stderr: proc.stderr,
      kill: proc.kill,
    }), { cmd: ['x'] }, 60_000, sink, limits);
    proc.exit(0);
    expect(await pending).toEqual({ exitCode: 0, timedOut: false, readError: undefined, outputIncomplete: true });
  });

  test('a process that exits before the deadline is not timed out while a held pipe is awaited', async () => {
    const kill = mock(() => undefined);
    const proc = {
      exited: Promise.resolve(0),
      stdout: new ReadableStream<Uint8Array<ArrayBuffer>>(),
      stderr: streamOf(),
      kill,
    };
    const outcome = await runProcess(spawnOf(proc), { cmd: ['x'] }, 5, new BufferedSink(), { killGraceMs: 10, drainGraceMs: 60 });
    expect(outcome).toMatchObject({ exitCode: 0, timedOut: false });
    expect(kill).not.toHaveBeenCalled();
  });

  test('a stream that cannot be read is a read error, not an unhandled rejection', async () => {
    const stdout = new ReadableStream<Uint8Array<ArrayBuffer>>();
    stdout.getReader();
    const proc = { exited: Promise.resolve(0), stdout, stderr: streamOf(), kill: () => undefined };
    const outcome = await runProcess(spawnOf(proc), { cmd: ['x'] }, 1000, new BufferedSink(), limits);
    expect(outcome.readError).toStartWith('Reading stdout failed: ');
  });

  test('a sink that throws while closing a pipe is a read error', async () => {
    const sink = { write: () => undefined, end: () => { throw new Error('sink broke'); } };
    const outcome = await runProcess(spawnOf(finishedProcess()), { cmd: ['x'] }, 1000, sink, limits);
    expect(outcome.readError).toBe('Reading stdout failed: sink broke');
  });

  test('giving up on a process that survives SIGKILL is logged with the command, pid and run', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { proc } = stubborn({ exitsOn: 'never' });
      const run = new ComposeRunRegistry({ limits }).create('deploy', 'app');
      run.start(async (io) => {
        io.phase('up', 5);
        return { kind: 'finished', phase: 'up', result: await io.run({ cmd: ['docker', 'compose', 'up'] }, 5), timeoutMs: 5 };
      }, spawnOf({ ...proc, pid: 4242 }));
      await bounded(run.done, 'run.done');
      const logged = errors.mock.calls.map((args) => args.join(' '));
      const line = logged.find((l) => l.startsWith('Gave up waiting for docker compose up'));
      expect(line).toContain('pid 4242');
      expect(line).toContain(`run ${run.runId}`);
      expect(line).toContain('deploy app');
      expect(line).toContain('phase up');
    } finally {
      errors.mockRestore();
    }
  });

  test('giving up on a pipe is logged with the run and phase and flagged in the result', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const run = new ComposeRunRegistry({ limits }).create('deploy', 'app');
      const proc = { exited: Promise.resolve(0), stdout: new ReadableStream<Uint8Array<ArrayBuffer>>(), stderr: streamOf(), kill: () => undefined };
      run.start(async (io) => {
        io.phase('up', 1000);
        return { kind: 'finished', phase: 'up', result: await io.run({ cmd: ['docker', 'compose', 'up'] }, 1000), timeoutMs: 1000 };
      }, spawnOf(proc));
      const result = await bounded(run.done, 'run.done');
      expect(result).toMatchObject({ status: 'success', droppedLines: 0, droppedBytes: 0, outputIncomplete: true });
      expect(zComposeFrames.result.safeParse(result).success).toBe(true);
      const line = errors.mock.calls.map((args) => args.join(' ')).find((l) => l.startsWith('Gave up waiting on output of'));
      expect(line).toContain(`run ${run.runId}`);
      expect(line).toContain('deploy app');
      expect(line).toContain('phase up');
    } finally {
      errors.mockRestore();
    }
  });

  test('a run that read everything carries no outputIncomplete', async () => {
    const run = new ComposeRunRegistry({ limits }).create('deploy', 'app');
    run.start(async (io) => ({ kind: 'finished', phase: 'up', result: await io.run({ cmd: ['x'] }, 1000), timeoutMs: 1000 }), spawnOf(finishedProcess()));
    expect('outputIncomplete' in await bounded(run.done, 'run.done')).toBe(false);
  });

  test('a failed result is logged once with the run, stack, phase, exit code and read error', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const run = new ComposeRunRegistry({ limits }).create('deploy', 'app');
      run.start(async (io) => {
        io.phase('up', 1000);
        return { kind: 'finished', phase: 'up', result: await io.run({ cmd: ['x'] }, 1000), timeoutMs: 1000 };
      }, spawnOf(unreadableProcess(143, 'kill')));
      await bounded(run.done, 'run.done');
      const failures = errors.mock.calls.map((args) => args.join(' ')).filter((l) => l.includes(run.runId));
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('deploy app');
      expect(failures[0]).toContain('phase up');
      expect(failures[0]).toContain('exit 143');
      expect(failures[0]).toContain('Reading stdout failed: pipe broke');
    } finally {
      errors.mockRestore();
    }
  });

  test('a successful result logs nothing', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const run = new ComposeRunRegistry({ limits }).create('deploy', 'app');
      run.start(async (io) => ({ kind: 'finished', phase: 'up', result: await io.run({ cmd: ['x'] }, 1000), timeoutMs: 1000 }), spawnOf(finishedProcess()));
      await bounded(run.done, 'run.done');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  test('a run that cannot build its result still sends a failed result frame and resolves done', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      let broken = false;
      const run = new ComposeRun('deploy', 'app', () => { if (broken) throw new Error('clock broke'); return 0; }, () => undefined, limits);
      const frames: ComposeFrameEvent[] = [];
      run.subscribe((frame) => frames.push(frame));
      broken = true;
      run.start(async (io) => ({ kind: 'finished', phase: 'up', result: await io.run({ cmd: ['x'] }, 1000), timeoutMs: 1000 }), spawnOf(finishedProcess()));
      const result = await bounded(run.done, 'run.done');

      expect(result).toMatchObject({ seq: 1, status: 'failed', exitCode: null, droppedLines: 0, droppedBytes: 0 });
      expect(result.detail).toContain('clock broke');
      expect(zComposeFrames.result.safeParse(result).success).toBe(true);
      expect(frames).toEqual([{ event: 'result', data: result }]);
      expect(run.result).toBe(result);
      expect(run.finishedAt).not.toBeNull();
      expect(errors.mock.calls.some((args) => args.join(' ').includes(run.runId))).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });

  test('a registry that fails to prune cannot stop a run from resolving', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const run = new ComposeRun('deploy', 'app', Date.now, () => { throw new Error('prune broke'); }, limits);
      run.start(async (io) => ({ kind: 'finished', phase: 'up', result: await io.run({ cmd: ['x'] }, 1000), timeoutMs: 1000 }), spawnOf(finishedProcess()));
      expect((await bounded(run.done, 'run.done')).status).toBe('success');
    } finally {
      errors.mockRestore();
    }
  });

  test('a truncated line between two normal lines keeps seq running 1 to n with no gap', async () => {
    const run = new ComposeRunRegistry({ limits }).create('deploy', 'app');
    const frames: ComposeFrameEvent[] = [];
    run.subscribe((frame) => frames.push(frame));
    const output = `first\n${'x'.repeat(5000)}\nlast\n`;
    run.start(async (io) => {
      io.phase('up', 1000);
      return { kind: 'finished', phase: 'up', result: await io.run({ cmd: ['x'] }, 1000), timeoutMs: 1000 };
    }, spawnOf(finishedProcess({ stdout: [output] })));
    await bounded(run.done, 'run.done');

    expect(frames.map((f) => f.event)).toEqual(['phase', 'line', 'line', 'line', 'result']);
    expect(frames.map((f) => f.data.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(frames[2].data).toMatchObject({ truncated: true });
  });

  test('a pipe that delivers after the result was sent adds no line frame and no retained line', async () => {
    let deliverLate!: (chunk: Uint8Array<ArrayBuffer>) => void;
    let secondReadStarted!: () => void;
    const started = new Promise<void>((resolve) => { secondReadStarted = resolve; });
    let reads = 0;
    const lateStdout = {
      getReader: () => ({
        read: () => {
          if (reads++ === 0) return new Promise<{ done: false; value: Uint8Array<ArrayBuffer> }>((resolve) => { deliverLate = (value) => resolve({ done: false, value }); });
          secondReadStarted();
          return new Promise<never>(() => undefined);
        },
        cancel: () => Promise.resolve(),
      }),
    };
    const proc = { exited: Promise.resolve(0), stdout: lateStdout, stderr: streamOf(), kill: () => undefined };
    const run = new ComposeRunRegistry({ limits }).create('deploy', 'app');
    const frames: ComposeFrameEvent[] = [];
    run.subscribe((frame) => frames.push(frame));
    run.start(async (io) => ({ kind: 'finished', phase: 'up', result: await io.run({ cmd: ['x'] }, 1000), timeoutMs: 1000 }), spawnOf(proc));
    await bounded(run.done, 'run.done');

    deliverLate(bytes('too late\n'));
    await bounded(started, 'the second read');

    expect(frames.map((f) => f.event)).toEqual(['result']);
    expect(run.lastLines).toEqual([]);
  });

  test('the fallback result frame keeps the drop counts of a capped run', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      let broken = false;
      const run = new ComposeRun('deploy', 'app', () => { if (broken) throw new Error('clock broke'); return 0; }, () => undefined, limits);
      broken = true;
      const line = `${'\u0001'.repeat(4146)}\n`;
      run.start(async (io) => ({
        kind: 'finished',
        phase: 'up',
        result: await io.run({ cmd: ['x'] }, 60_000),
        timeoutMs: 60_000,
      }), spawnOf(backpressuredProcess(Array.from({ length: 600 }, () => line), 0)));
      const result = await bounded(run.done, 'run.done', 3000);

      expect(result.detail).toContain('clock broke');
      expect(result.droppedLines).toBeGreaterThan(0);
      expect(result.droppedBytes).toBeGreaterThan(0);
    } finally {
      errors.mockRestore();
    }
  });

  test('a real process tree holding the pipe open cannot outlast the timeout by its own lifetime', async () => {
    const started = Date.now();
    const outcome = await runProcess(Bun.spawn, { cmd: ['sh', '-c', 'sleep 1.5 & sleep 1.5'] }, 100, new BufferedSink(), limits);
    expect(outcome.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('a process that floods output cannot starve the deadline timer', async () => {
    let killed = false;
    let resolveExit!: (code: number) => void;
    const chunk = new Uint8Array(64 * 1024).fill(10);
    const proc = {
      exited: new Promise<number>((resolve) => { resolveExit = resolve; }),
      stdout: new ReadableStream<Uint8Array<ArrayBuffer>>({
        pull(controller) {
          if (killed) controller.close();
          else controller.enqueue(chunk.slice());
        },
      }),
      stderr: streamOf(),
      kill: () => { killed = true; resolveExit(143); },
    };
    const outcome = await runProcess(spawnOf(proc), { cmd: ['x'] }, 20, new SseSink(() => undefined), limits);
    expect(outcome).toMatchObject({ exitCode: 143, timedOut: true });
  });

  test('a failed pipe read kills the process, keeps draining the other pipe and reports it honestly', async () => {
    let resolveExit!: (code: number) => void;
    let killed = 0;
    const badStdout = new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull(controller) { controller.error(new Error('pipe broke')); },
    });
    const stderr = new ControlledProcess();
    const proc = {
      exited: new Promise<number>((resolve) => { resolveExit = resolve; }),
      stdout: badStdout,
      stderr: stderr.stderr,
      kill: () => { killed++; stderr.write('stderr', 'late diagnostics\n'); stderr.exit(143); resolveExit(143); },
    };
    const sink = new BufferedSink();
    const outcome = await runProcess(spawnOf(proc), { cmd: ['x'] }, 60_000, sink, limits);

    expect(killed).toBe(1);
    expect(outcome).toEqual({ exitCode: 143, timedOut: false, readError: 'Reading stdout failed: pipe broke' });
    expect(sink.text('stderr')).toBe('late diagnostics\n');
  });

  test('runBuffered turns a read failure into a throw, as a failed read did before', async () => {
    const proc = {
      exited: Promise.resolve(0),
      stdout: new ReadableStream<Uint8Array<ArrayBuffer>>({ pull(c) { c.error(new Error('pipe broke')); } }),
      stderr: streamOf(),
      kill: () => undefined,
    };
    const outcome = await runBuffered(spawnOf(proc), { cmd: ['x'] }, 1000, limits).then(() => 'resolved', (e: Error) => e.message);
    expect(outcome).toBe('Reading stdout failed: pipe broke');
  });

  test('a run with a failed read finishes only after the process is gone, with a detail and no spawn code', async () => {
    let resolveExit!: (code: number) => void;
    const stderr = new ControlledProcess();
    const proc = {
      exited: new Promise<number>((resolve) => { resolveExit = resolve; }),
      stdout: new ReadableStream<Uint8Array<ArrayBuffer>>({ pull(c) { c.error(new Error('pipe broke')); } }),
      stderr: stderr.stderr,
      kill: () => { stderr.exit(143); resolveExit(143); },
    };
    const run = new ComposeRunRegistry({ limits }).create('deploy', 'app');
    const lateLines: string[] = [];
    run.start(async (io) => {
      const result = await io.run({ cmd: ['x'] }, 60_000);
      return { kind: 'finished', phase: 'up', result, timeoutMs: 60_000 };
    }, spawnOf(proc));
    const result = await bounded(run.done, 'run.done');
    run.subscribe((f) => { if (f.event === 'line') lateLines.push(f.data.text); });

    expect(result).toMatchObject({ status: 'failed', exitCode: 143, timedOut: false, failedPhase: 'up', detail: 'Reading stdout failed: pipe broke' });
    expect('code' in result).toBe(false);
    expect(lateLines).toEqual([]);
  });

  test('a run whose process never exits still finishes, with a null exit code', async () => {
    const { proc } = stubborn({ exitsOn: 'never' });
    const run = new ComposeRunRegistry({ limits }).create('deploy', 'app');
    run.start(async (io) => {
      const result = await io.run({ cmd: ['x'] }, 5);
      return { kind: 'finished', phase: 'up', result, timeoutMs: 5 };
    }, spawnOf(proc));
    expect(await bounded(run.done, 'run.done')).toMatchObject({ status: 'failed', exitCode: null, timedOut: true, timeoutMs: 5, failedPhase: 'up' });
  });
});

const minimalResult = { seq: 4, status: 'failed', exitCode: 1, timedOut: false, droppedLines: 0, droppedBytes: 0 } as const;
const tailEntry = { stream: 'stdout', text: 'x' } as const;

describe('compose frame schemas', () => {
  test('a minimal result frame parses', () => {
    expect(zComposeFrames.result.parse(minimalResult)).toEqual(minimalResult);
  });

  test('seq starts at 1', () => {
    expect(zComposeFrames.result.safeParse({ ...minimalResult, seq: 0 }).success).toBe(false);
    expect(zComposeFrames.phase.safeParse({ seq: 0, phase: 'up' }).success).toBe(false);
    expect(zComposeFrames.line.safeParse({ seq: 0, stream: 'stdout', text: 'x' }).success).toBe(false);
  });

  test('a tail holds at most 100 lines', () => {
    expect(zComposeFrames.result.safeParse({ ...minimalResult, tail: Array.from({ length: 100 }, () => tailEntry) }).success).toBe(true);
    expect(zComposeFrames.result.safeParse({ ...minimalResult, tail: Array.from({ length: 101 }, () => tailEntry) }).success).toBe(false);
  });

  test('outputIncomplete is true or absent', () => {
    expect(zComposeFrames.result.safeParse({ ...minimalResult, outputIncomplete: true }).success).toBe(true);
    expect(zComposeFrames.result.safeParse({ ...minimalResult, outputIncomplete: false }).success).toBe(false);
  });

  test('the drop counts are required', () => {
    const without = (key: string) => Object.fromEntries(Object.entries(minimalResult).filter(([name]) => name !== key));
    const withoutLines = without('droppedLines');
    const withoutBytes = without('droppedBytes');
    expect(zComposeFrames.result.safeParse(withoutLines).success).toBe(false);
    expect(zComposeFrames.result.safeParse(withoutBytes).success).toBe(false);
  });

  test('truncated is true or absent on a line and on a tail entry', () => {
    expect(zComposeFrames.line.safeParse({ seq: 1, stream: 'stdout', text: 'x', truncated: true }).success).toBe(true);
    expect(zComposeFrames.line.safeParse({ seq: 1, stream: 'stdout', text: 'x', truncated: false }).success).toBe(false);
    expect(zComposeFrames.result.safeParse({ ...minimalResult, tail: [{ ...tailEntry, truncated: false }] }).success).toBe(false);
  });

  test('every phase the agent announces parses and keeps its value', () => {
    for (const phase of ['prepare', 'pull', 'up', 'down', 'restart', 'start', 'stop'] as const) {
      expect(zComposeFrames.phase.parse({ seq: 1, phase })).toEqual({ seq: 1, phase });
    }
  });
});
