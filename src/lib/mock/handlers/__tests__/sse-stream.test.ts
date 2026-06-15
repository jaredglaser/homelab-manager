import { describe, it, expect } from 'bun:test';

import { sseData, sseEvent, createSseResponse } from '@/lib/mock/handlers/sse-stream';

async function readFrames(response: Response, count: number): Promise<string[]> {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const frames: string[] = [];
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) frames.push(value);
  }
  await reader.cancel();
  return frames;
}

describe('sse-stream', () => {
  describe('frame formatting', () => {
    it('formats a default message frame', () => {
      expect(sseData({ a: 1 })).toBe('data: {"a":1}\n\n');
    });

    it('formats a named event frame', () => {
      expect(sseEvent('backlog_done', {})).toBe('event: backlog_done\ndata: {}\n\n');
    });
  });

  describe('createSseResponse', () => {
    it('sets the text/event-stream content type', () => {
      const res = createSseResponse(() => {});
      expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    });

    it('emits frames the producer sends on open', async () => {
      const res = createSseResponse((c) => {
        c.send({ hello: 'world' });
        c.sendEvent('ready', { ok: true });
      });
      const frames = await readFrames(res, 2);
      expect(frames[0]).toBe('data: {"hello":"world"}\n\n');
      expect(frames[1]).toBe('event: ready\ndata: {"ok":true}\n\n');
    });

    it('clears interval timers when the stream is cancelled', async () => {
      let ticks = 0;
      const res = createSseResponse((c) => {
        c.send({ first: true });
        c.interval(5, () => {
          ticks += 1;
          c.send({ tick: ticks });
        });
      });
      const reader = res.body!.getReader();
      await reader.read();
      await reader.cancel();
      const before = ticks;
      await new Promise((r) => setTimeout(r, 30));
      // After cancel the interval is cleared, so no further ticks accumulate.
      expect(ticks).toBe(before);
    });
  });
});
