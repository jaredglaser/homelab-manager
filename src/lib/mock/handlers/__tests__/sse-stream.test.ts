import { describe, it, expect, spyOn, afterEach } from 'bun:test';

import { sseData, sseEvent, createSseResponse } from '@/lib/mock/handlers/sse-stream';

// The producer never closes the stream, so reading to completion would hang; take
// a fixed count and cancel. One send is one enqueue is one read, so frames never split.
async function readFrames(response: Response, count: number): Promise<string[]> {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const frames: string[] = [];
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    frames.push(value);
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

      function captureTimers(): {
        scheduled: { id: number; tick: () => void }[];
        cleared: unknown[];
      } {
        const scheduled: { id: number; tick: () => void }[] = [];
        const cleared: unknown[] = [];
        let nextId = 1;
        spies.push(
          spyOn(globalThis, 'setInterval').mockImplementation(((tick: () => void) => {
            const id = nextId++;
            scheduled.push({ id, tick });
            return id;
          }) as unknown as typeof setInterval),
          spyOn(globalThis, 'clearInterval').mockImplementation(((id: number) => {
            cleared.push(id);
          }) as unknown as typeof clearInterval),
        );
        return { scheduled, cleared };
      }

      it('clears interval timers and stops ticking after cancel', async () => {
        const { scheduled, cleared } = captureTimers();

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

      it('clears interval timers when a write fails on a closed controller', () => {
        const { scheduled, cleared } = captureTimers();
        spies.push(
          spyOn(TextEncoder.prototype, 'encode').mockImplementation(() => {
            throw new TypeError('Invalid state: Controller is already closed');
          }),
        );

        let ticks = 0;
        createSseResponse((c) => {
          c.interval(5, () => {
            ticks += 1;
            c.send({ tick: ticks });
          });
          c.send({ first: true });
        });

        expect(scheduled).toHaveLength(1);
        expect(cleared).toEqual([scheduled[0].id]);

        scheduled[0].tick();
        expect(ticks).toBe(0);
      });

      // The shipped producers (statsHandler, dockerLogs) send before registering
      // their interval, so this is the ordering that actually reaches the leak.
      it('schedules no timer when the first send already tore the stream down', () => {
        const { scheduled, cleared } = captureTimers();
        spies.push(
          spyOn(TextEncoder.prototype, 'encode').mockImplementation(() => {
            throw new TypeError('Invalid state: Controller is already closed');
          }),
        );

        createSseResponse((c) => {
          c.send({ first: true });
          c.interval(5, () => c.send({ tick: true }));
        });

        expect(scheduled).toEqual([]);
        expect(cleared).toEqual([]);
      });
    });
  });
});
