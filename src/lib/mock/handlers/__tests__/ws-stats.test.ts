import { describe, it, expect, afterEach } from 'bun:test';

import {
  createConnectionHandler,
  statsTickFrame,
  STATS_DROP_COUNT,
  STATS_DROP_EVERY_TICKS,
  type MuxMockClient,
} from '@/lib/mock/handlers/ws';
import { dockerStatsChannel } from '@/lib/sse/channels/docker-stats';
import { zfsStatsChannel } from '@/lib/sse/channels/zfs-stats';
import { proxmoxStatsChannel } from '@/lib/sse/channels/proxmox-stats';

interface MuxFrame {
  type: string;
  topic?: string;
  kind?: string;
  payload?: unknown;
  count?: number;
  ref?: number;
  ok?: boolean;
  error?: string;
}

const STATS_TOPICS = {
  'stats:docker': dockerStatsChannel,
  'stats:zfs': zfsStatsChannel,
  'stats:proxmox': proxmoxStatsChannel,
} as const;

const openConnections: Array<() => void> = [];

afterEach(() => {
  for (const close of openConnections.splice(0)) close();
});

function connect() {
  const frames: MuxFrame[] = [];
  const listeners = new Map<string, (event: { data?: unknown }) => void>();
  const client: MuxMockClient = {
    send: (data) => {
      frames.push(JSON.parse(data) as MuxFrame);
    },
    addEventListener: (type, listener) => {
      listeners.set(type, listener);
    },
  };
  createConnectionHandler({ client });
  const close = () => listeners.get('close')?.({});
  openConnections.push(close);
  return {
    frames,
    command(type: 'sub' | 'unsub', topics: string[]) {
      listeners.get('message')?.({ data: JSON.stringify({ type, ref: 7, topics }) });
    },
    dataFrames(topic: string) {
      return frames.filter((f) => f.type === 'event' && f.topic === topic && f.kind === 'data');
    },
    close,
  };
}

function parseFrame(raw: string): MuxFrame {
  return JSON.parse(raw) as MuxFrame;
}

function rowsOf(topic: string, tick: number, time: Date): Array<Record<string, unknown>> {
  const frame = statsTickFrame(topic, tick, time);
  expect(frame).not.toBeNull();
  return (parseFrame(frame!).payload ?? []) as Array<Record<string, unknown>>;
}

function withoutTimes(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const copy = { ...row };
    delete copy.time;
    return copy;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('mock mux stats topics', () => {
  it('acks stats subscriptions and sends no frame on subscribe (deltas only)', () => {
    const conn = connect();
    conn.command('sub', ['stats:docker']);
    // History belongs to the REST preload (gotcha 17): nothing is replayed on
    // subscribe, so the ack is the only frame until the first poll tick.
    expect(conn.frames).toEqual([{ type: 'ack', ref: 7, ok: true }]);
  });

  it('serves generator snapshots that match the stats channel wire schemas', () => {
    const time = new Date(1728000000000);
    for (const [topic, channel] of Object.entries(STATS_TOPICS)) {
      const raw = statsTickFrame(topic, 0, time)!;
      const frame = parseFrame(raw);
      expect(frame.kind).toBe('data');
      expect(frame.topic).toBe(topic);
      const rows = frame.payload as Array<{ time: number }>;
      expect(rows.length).toBeGreaterThan(0);
      // time is epoch-ms end to end with no revive (gotcha 18).
      for (const row of rows) expect(row.time).toBe(time.getTime());
      expect(channel.schema.safeParse(frame.payload).success).toBe(true);
    }
  });

  it('drifts values over time instead of replaying a fixed snapshot', () => {
    for (const topic of Object.keys(STATS_TOPICS)) {
      const base = new Date(1728000000000);
      const first = rowsOf(topic, 2, base);
      const second = rowsOf(topic, 3, new Date(base.getTime() + 1000));
      const third = rowsOf(topic, 4, new Date(base.getTime() + 2000));
      const times = [first, second, third].map((rows) => rows[0].time);
      expect(times).toEqual([base.getTime(), base.getTime() + 1000, base.getTime() + 2000]);
      // The generators are deterministic in (entity, time), so differing metric
      // values across ticks proves the feed drifts rather than looping one frame.
      expect(withoutTimes(second)).not.toEqual(withoutTimes(first));
      expect(withoutTimes(third)).not.toEqual(withoutTimes(second));
    }
  });

  it('summarizes each drop burst in one dropped frame and sheds exactly that many snapshots', () => {
    for (const topic of Object.keys(STATS_TOPICS)) {
      const time = new Date(1728000000000);
      const ticks = Array.from({ length: 3 * STATS_DROP_EVERY_TICKS }, (_, tick) =>
        statsTickFrame(topic, tick, time),
      );
      const droppedAt = ticks
        .map((raw, tick) => ({ raw, tick }))
        .filter(({ raw }) => raw !== null && parseFrame(raw!).kind === 'dropped');
      expect(droppedAt.length).toBeGreaterThanOrEqual(2);

      for (const { raw, tick } of droppedAt) {
        // Exact wire shape, pinned byte-for-byte: no payload field on drops.
        expect(raw).toBe(
          JSON.stringify({ type: 'event', topic, kind: 'dropped', count: STATS_DROP_COUNT }),
        );
        expect(parseFrame(raw!)).not.toHaveProperty('payload');
        // The burst sheds the dropped frame's tick plus the following count-1.
        for (let shed = 1; shed < STATS_DROP_COUNT; shed++) {
          expect(ticks[tick + shed]).toBeNull();
        }
        expect(ticks[tick + STATS_DROP_COUNT]).not.toBeNull();
      }
    }
  });

  it('staggers burst phases across the three feeds', () => {
    const time = new Date(1728000000000);
    const firstBursts = Object.keys(STATS_TOPICS).map((topic) => {
      for (let tick = 1; tick <= STATS_DROP_EVERY_TICKS; tick++) {
        const raw = statsTickFrame(topic, tick, time);
        if (raw !== null && parseFrame(raw).kind === 'dropped') return tick;
      }
      throw new Error(`no drop burst for ${topic}`);
    });
    expect(new Set(firstBursts).size).toBe(firstBursts.length);
  });

  it('rejects unknown stats sources with a gone error frame', () => {
    const conn = connect();
    conn.command('sub', ['stats:bogus']);
    const error = conn.frames.find((f) => f.kind === 'error');
    expect(error?.payload).toEqual({ message: 'Unsupported topic: stats:bogus', gone: true });
    expect(conn.dataFrames('stats:bogus')).toHaveLength(0);
  });

  it('streams live snapshots until unsubscribe stops the feed', async () => {
    const conn = connect();
    conn.command('sub', ['stats:docker']);
    // First poll tick lands at ~1s, like statsPollService.
    const deadline = Date.now() + 2500;
    while (conn.dataFrames('stats:docker').length < 2 && Date.now() < deadline) {
      await sleep(50);
    }
    expect(conn.dataFrames('stats:docker').length).toBeGreaterThanOrEqual(2);

    conn.command('unsub', ['stats:docker']);
    const settled = conn.frames.length;
    await sleep(1200);
    expect(conn.frames.length).toBe(settled);
  });
});
