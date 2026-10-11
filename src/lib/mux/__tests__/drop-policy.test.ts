import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  MuxWriteQueue,
  DEFAULT_MUX_DROP_POLICY,
  type MuxDropPolicyConfig,
} from '@/lib/mux/drop-policy';
import type { MuxFrameBody } from '@/lib/mux/protocol';
import { mockSetTimeout, type TimerMock } from '@/lib/test/mock-timers';

const HIGH_BYTES = 2 * 1024 * 1024;

function makeQueue(config?: MuxDropPolicyConfig) {
  const sent: string[] = [];
  const errors: { err: unknown; topic: string | null }[] = [];
  let buffered = 0;
  let failSend = false;
  const queue = new MuxWriteQueue({
    send: (json) => {
      if (failSend) throw new Error('send failed');
      sent.push(json);
    },
    getBufferedBytes: () => buffered,
    config,
    onSendError: (err, topic) => {
      errors.push({ err, topic });
    },
  });
  return {
    queue,
    sent,
    errors,
    setBuffered: (n: number) => {
      buffered = n;
    },
    setFailSend: (v: boolean) => {
      failSend = v;
    },
  };
}

function statsFrame(topic: string, time: number): MuxFrameBody {
  return { topic, kind: 'data', payload: [{ time, host: 'server1', cpu_percent: 1 }] };
}

describe('MuxWriteQueue drop policy', () => {
  let timers: TimerMock;

  beforeEach(() => {
    timers = mockSetTimeout();
  });

  afterEach(() => {
    timers.restore();
  });

  it('delivers bulk and control frames untouched when there is no pressure', () => {
    const { queue, sent } = makeQueue();

    expect(queue.pushFrame(statsFrame('stats:docker', 1))).toBe('delivered');
    expect(queue.pushFrame({ topic: 'inventory', kind: 'data', payload: { type: 'init', containers: [] } })).toBe('delivered');

    expect(sent).toEqual([
      '{"type":"event","topic":"stats:docker","kind":"data","payload":[{"time":1,"host":"server1","cpu_percent":1}]}',
      '{"type":"event","topic":"inventory","kind":"data","payload":{"type":"init","containers":[]}}',
    ]);
    expect(timers.scheduled).toHaveLength(0);
  });

  it('sheds bulk data under pressure and reports per-topic counts on the tick', () => {
    const { queue, sent, setBuffered } = makeQueue();
    setBuffered(HIGH_BYTES);

    expect(queue.pushFrame(statsFrame('stats:docker', 1))).toBe('shed');
    expect(queue.pushFrame(statsFrame('stats:docker', 2))).toBe('shed');
    expect(queue.pushFrame(statsFrame('stats:docker', 3))).toBe('shed');
    expect(queue.pushFrame(statsFrame('stats:zfs', 1))).toBe('shed');
    expect(sent).toEqual([]);
    expect(timers.pending).toHaveLength(1);

    timers.fireNext();

    expect(sent).toEqual([
      '{"type":"event","topic":"stats:docker","kind":"dropped","count":3}',
      '{"type":"event","topic":"stats:zfs","kind":"dropped","count":1}',
    ]);

    expect(queue.pushFrame(statsFrame('stats:docker', 4))).toBe('shed');
    timers.fireNext();
    expect(sent[2]).toBe('{"type":"event","topic":"stats:docker","kind":"dropped","count":1}');
  });

  it('coalesces control frames to latest per topic under pressure', () => {
    const { queue, sent, setBuffered } = makeQueue();
    setBuffered(HIGH_BYTES);

    expect(queue.pushFrame({ topic: 'inventory', kind: 'data', payload: { rev: 1 } })).toBe('coalesced');
    expect(queue.pushFrame({ topic: 'inventory', kind: 'data', payload: { rev: 2 } })).toBe('coalesced');
    expect(queue.pushFrame({ topic: 'inventory', kind: 'data', payload: { rev: 3 } })).toBe('coalesced');
    expect(sent).toEqual([]);

    timers.fireNext();

    expect(sent).toEqual(['{"type":"event","topic":"inventory","kind":"data","payload":{"rev":3}}']);
  });

  it('never sheds heartbeats under pressure', () => {
    const { queue, sent, setBuffered } = makeQueue();
    setBuffered(HIGH_BYTES);

    queue.pushPing();

    expect(sent).toEqual(['{"type":"ping"}']);
    expect(timers.scheduled).toHaveLength(0);
  });

  it('never sheds non-data frames on bulk topics', () => {
    const { queue, sent, setBuffered } = makeQueue();
    setBuffered(HIGH_BYTES);

    expect(queue.pushFrame({ topic: 'logs:s/abc', kind: 'backlog_start', payload: {} })).toBe('delivered');
    expect(queue.pushFrame({ topic: 'logs:s/abc', kind: 'data', payload: { lines: [] } })).toBe('shed');
    expect(queue.pushFrame({ topic: 'logs:s/abc', kind: 'backlog_done', payload: {} })).toBe('delivered');
    expect(queue.pushFrame({ topic: 'logs:s/abc', kind: 'stream_end', payload: {} })).toBe('delivered');
    expect(queue.pushFrame({ topic: 'logs:s/abc', kind: 'error', payload: { message: 'x', gone: false } })).toBe('delivered');
    expect(queue.pushFrame({ topic: 'stats:docker', kind: 'dropped', count: 2 })).toBe('delivered');

    expect(sent).toEqual([
      '{"type":"event","topic":"logs:s/abc","kind":"backlog_start","payload":{}}',
      '{"type":"event","topic":"logs:s/abc","kind":"backlog_done","payload":{}}',
      '{"type":"event","topic":"logs:s/abc","kind":"stream_end","payload":{}}',
      '{"type":"event","topic":"logs:s/abc","kind":"error","payload":{"message":"x","gone":false}}',
      '{"type":"event","topic":"stats:docker","kind":"dropped","count":2}',
    ]);

    timers.fireNext();
    expect(sent[5]).toBe('{"type":"event","topic":"logs:s/abc","kind":"dropped","count":1}');
  });

  it('keeps shedding between the watermarks and resumes on the low-water mark', () => {
    const { queue, sent, setBuffered } = makeQueue({
      highWaterBytes: 1000,
      lowWaterBytes: 100,
      reportIntervalMs: 5000,
    });

    setBuffered(2000);
    expect(queue.pushFrame(statsFrame('stats:docker', 1))).toBe('shed');
    setBuffered(500);
    expect(queue.pushFrame(statsFrame('stats:docker', 2))).toBe('shed');
    setBuffered(50);
    expect(queue.pushFrame(statsFrame('stats:docker', 3))).toBe('delivered');

    expect(sent).toEqual([
      '{"type":"event","topic":"stats:docker","kind":"dropped","count":2}',
      '{"type":"event","topic":"stats:docker","kind":"data","payload":[{"time":3,"host":"server1","cpu_percent":1}]}',
    ]);
  });

  it('drops pending state per topic on clearTopic', () => {
    const { queue, sent, setBuffered } = makeQueue();
    setBuffered(HIGH_BYTES);

    queue.pushFrame(statsFrame('stats:docker', 1));
    queue.pushFrame(statsFrame('stats:docker', 2));
    queue.pushFrame({ topic: 'inventory', kind: 'data', payload: { rev: 1 } });
    queue.clearTopic('stats:docker');

    timers.fireNext();
    expect(sent).toEqual(['{"type":"event","topic":"inventory","kind":"data","payload":{"rev":1}}']);

    queue.clearTopic('inventory');
    expect(timers.pending).toHaveLength(0);
  });

  it('dispose clears the pending tick', () => {
    const { queue, setBuffered } = makeQueue();
    setBuffered(HIGH_BYTES);

    queue.pushFrame(statsFrame('stats:docker', 1));
    expect(timers.pending).toHaveLength(1);

    queue.dispose();
    expect(timers.pending).toHaveLength(0);
  });

  it('reports send failures without throwing and keeps pings silent', () => {
    const { queue, sent, errors, setBuffered, setFailSend } = makeQueue();

    setFailSend(true);
    expect(queue.pushFrame({ topic: 'inventory', kind: 'data', payload: { rev: 1 } })).toBe('failed');
    expect(errors).toHaveLength(1);
    expect(errors[0].topic).toBe('inventory');

    queue.pushPing();
    expect(errors).toHaveLength(1);

    setBuffered(HIGH_BYTES);
    expect(queue.pushFrame(statsFrame('stats:docker', 1))).toBe('shed');
    timers.fireNext();
    expect(errors).toHaveLength(2);
    expect(errors[1].topic).toBe('stats:docker');
    expect(sent).toEqual([]);
  });

  it('never sheds frames on topics outside the registry', () => {
    const { queue, sent, setBuffered } = makeQueue();
    setBuffered(HIGH_BYTES);

    expect(queue.pushFrame({ topic: 'mystery', kind: 'data', payload: { rev: 1 } })).toBe('delivered');
    expect(sent).toEqual(['{"type":"event","topic":"mystery","kind":"data","payload":{"rev":1}}']);
  });

  it('keeps the default policy conservative and ordered', () => {
    expect(DEFAULT_MUX_DROP_POLICY.lowWaterBytes).toBeLessThan(DEFAULT_MUX_DROP_POLICY.highWaterBytes);
    expect(DEFAULT_MUX_DROP_POLICY.highWaterBytes).toBeGreaterThanOrEqual(1024 * 1024);
    expect(DEFAULT_MUX_DROP_POLICY.reportIntervalMs).toBeGreaterThan(0);
    expect(DEFAULT_MUX_DROP_POLICY.reportIntervalMs).toBeLessThanOrEqual(5000);
  });
});
