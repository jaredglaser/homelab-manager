import { describe, it, expect, spyOn, afterEach } from 'bun:test';

import { sseData, sseEvent, createSseResponse } from '@/lib/mock/handlers/sse-stream';

const FRAME_DELIMITER = '\n\n';

async function readFrames(response: Response, count: number): Promise<string[]> {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const frames: string[] = [];
  let buffer = '';
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value ?? '';
    let end = buffer.indexOf(FRAME_DELIMITER);
    while (end !== -1 && frames.length < count) {
      frames.push(buffer.slice(0, end + FRAME_DELIMITER.length));
      buffer = buffer.slice(end + FRAME_DELIMITER.length);
      end = buffer.indexOf(FRAME_DELIMITER);
    }
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

    describe('interval teardown', () => {
      const spies: { mockRestore: () => void }[] = [];

      afterEach(() => {
        for (const spy of spies.splice(0)) spy.mockRestore();
      });

      it('clears interval timers and stops ticking after cancel', async () => {
        const scheduled: { id: number; tick: () => void }[] = [];
        const cleared: unknown[] = [];
        let nextId = 1;

        const setSpy = spyOn(globalThis, 'setInterval').mockImplementation(((
          tick: () => void,
        ) => {
          const id = nextId++;
          scheduled.push({ id, tick });
          return id;
        }) as unknown as typeof setInterval);
        const clearSpy = spyOn(globalThis, 'clearInterval').mockImplementation(((
          id: number,
        ) => {
          cleared.push(id);
        }) as unknown as typeof clearInterval);
        spies.push(setSpy, clearSpy);

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
        expect(scheduled).toHaveLength(1);

        scheduled[0].tick();
        expect(ticks).toBe(1);

        await reader.cancel();
        expect(cleared).toEqual([scheduled[0].id]);

        scheduled[0].tick();
        expect(ticks).toBe(1);
      });
    });
  });
});
