import { describe, it, expect } from 'bun:test';
import { consumeSseStream, type SseFrame } from '../parse-sse-stream';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const neverAborts = new AbortController().signal;

async function collect(chunks: string[], signal = neverAborts): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  await consumeSseStream(streamOf(chunks), signal, (frame) => frames.push(frame));
  return frames;
}

describe('consumeSseStream', () => {
  it('parses a default data frame', async () => {
    const frames = await collect(['data: {"text":"hi","stream":"stdout"}\n\n']);
    expect(frames).toEqual([{ event: null, data: '{"text":"hi","stream":"stdout"}' }]);
  });

  it('parses a named event frame', async () => {
    const frames = await collect(['event: backlog_done\ndata: {}\n\n']);
    expect(frames).toEqual([{ event: 'backlog_done', data: '{}' }]);
  });

  it('ignores comment heartbeat lines', async () => {
    const frames = await collect([': ok\n\n', ':\n\ndata: x\n\n']);
    expect(frames).toEqual([{ event: null, data: 'x' }]);
  });

  it('reassembles a frame split across chunks', async () => {
    const frames = await collect(['data: {"te', 'xt":"hi"}\n', '\ndata: next\n\n']);
    expect(frames).toEqual([
      { event: null, data: '{"text":"hi"}' },
      { event: null, data: 'next' },
    ]);
  });

  it('normalizes CRLF separators', async () => {
    const frames = await collect(['event: stream_end\r\ndata: {}\r\n\r\n']);
    expect(frames).toEqual([{ event: 'stream_end', data: '{}' }]);
  });

  it('joins multiple data lines with newlines', async () => {
    const frames = await collect(['data: line-one\ndata: line-two\n\n']);
    expect(frames).toEqual([{ event: null, data: 'line-one\nline-two' }]);
  });

  it('stops reading when the signal aborts', async () => {
    const controller = new AbortController();
    let pullCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount++;
        controller.enqueue(new TextEncoder().encode('data: x\n\n'));
      },
    });
    const frames: SseFrame[] = [];
    const consumed = consumeSseStream(stream, controller.signal, (frame) => frames.push(frame));
    controller.abort();
    await consumed;
    expect(pullCount).toBeLessThan(5);
  });

  it('does not emit a trailing incomplete frame', async () => {
    const frames = await collect(['data: complete\n\ndata: partial']);
    expect(frames).toEqual([{ event: null, data: 'complete' }]);
  });
});
