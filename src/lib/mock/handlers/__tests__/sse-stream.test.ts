import { describe, it, expect, spyOn, afterEach } from 'bun:test';

import { sseData, sseEvent, createSseResponse } from '@/lib/mock/handlers/sse-stream';
import { mockSetInterval, type TimerMock } from '@/lib/test/mock-timers';

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
      const restorers: Array<() => void> = [];

      afterEach(() => {
        for (const restore of restorers.splice(0)) restore();
      });

      function captureTimers(): TimerMock {
        const intervals = mockSetInterval();
        restorers.push(() => intervals.restore());
        return intervals;
      }

      it('clears interval timers and stops ticking after cancel', async () => {
        const intervals = captureTimers();

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
        expect(intervals.scheduled).toHaveLength(1);

        intervals.fire(intervals.scheduled[0]);
        expect(ticks).toBe(1);

        await reader.cancel();
        expect(intervals.clearSpy.mock.calls.map((call: unknown[]) => call[0])).toEqual([intervals.scheduled[0].id]);

        intervals.fire(intervals.scheduled[0]);
        expect(ticks).toBe(1);
      });

      it('clears interval timers when a write fails on a closed controller', () => {
        const intervals = captureTimers();
        const encodeSpy = spyOn(TextEncoder.prototype, 'encode').mockImplementation(() => {
          throw new TypeError('Invalid state: Controller is already closed');
        });
        restorers.push(() => encodeSpy.mockRestore());

        let ticks = 0;
        createSseResponse((c) => {
          c.interval(5, () => {
            ticks += 1;
            c.send({ tick: ticks });
          });
          c.send({ first: true });
        });

        expect(intervals.scheduled).toHaveLength(1);
        expect(intervals.clearSpy.mock.calls.map((call: unknown[]) => call[0])).toEqual([intervals.scheduled[0].id]);

        intervals.fire(intervals.scheduled[0]);
        expect(ticks).toBe(0);
      });

      // The shipped producer (dockerLogs) sends before registering its interval,
      // so this is the ordering that actually reaches the leak.
      it('schedules no timer when the first send already tore the stream down', () => {
        const intervals = captureTimers();
        const encodeSpy = spyOn(TextEncoder.prototype, 'encode').mockImplementation(() => {
          throw new TypeError('Invalid state: Controller is already closed');
        });
        restorers.push(() => encodeSpy.mockRestore());

        createSseResponse((c) => {
          c.send({ first: true });
          c.interval(5, () => c.send({ tick: true }));
        });
        expect(intervals.scheduled).toEqual([]);
        expect(intervals.clearSpy).not.toHaveBeenCalled();
      });
    });
  });
});
