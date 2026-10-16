import { describe, it, expect, mock, beforeEach } from 'bun:test';
import type { Peer } from 'crossws';
import { z } from 'zod';
import { renderHook, act, waitFor } from '@testing-library/react';
import { mockModule } from '@/lib/test/mock-module';
import { FakeMuxConnection } from '@/lib/test/fake-mux';
import { mockSetTimeout, mockSetInterval } from '@/lib/test/mock-timers';
import type { MuxFrameBody } from '@/lib/mux/protocol';

const fakeMux = new FakeMuxConnection();
mockModule<typeof import('@/lib/mux/mux-connection')>('@/lib/mux/mux-connection', (real) => ({
  ...real,
  muxConnection: fakeMux,
}));

mockModule<typeof import('@/lib/auth/sse-auth')>('@/lib/auth/sse-auth', (real) => ({
  ...real,
  authenticateSSE: mock(async () => ({ id: 'test-user' } as unknown)),
}));

import { createMuxWsHandlers } from '../mux';
import { useMuxChannel } from '@/lib/mux/use-mux-channel';
import { useTimeSeriesStream } from '@/hooks/useTimeSeriesStream';

interface WireRow {
  key: string;
  time: number;
  entity: string;
}

const rowSchema = z.array(z.object({ key: z.string(), time: z.number(), entity: z.string() }));
const statsChannel = { topic: 'stats:docker', schema: rowSchema, revive: (rows: WireRow[]): WireRow[] => rows };
const controlSchema = z.object({ rev: z.number() });
const controlChannel = { topic: 'inventory', schema: controlSchema };

const rowAccessors = {
  getKey: (r: WireRow) => r.key,
  getTime: (r: WireRow) => r.time,
  getEntity: (r: WireRow) => r.entity,
};

interface FakePeer {
  id: string;
  request: Request;
  bufferedAmount: number;
  sentRaw: string[];
  closeCalls: { code?: number; reason?: string }[];
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
}

function makePeer(id: string): FakePeer {
  const peer: FakePeer = {
    id,
    request: new Request('http://localhost:3000/api/mux'),
    bufferedAmount: 0,
    sentRaw: [],
    closeCalls: [],
    send: (data: string) => {
      peer.sentRaw.push(data);
    },
    close: (code?: number, reason?: string) => {
      peer.closeCalls.push({ code, reason });
    },
  };
  return peer;
}

function command(type: 'sub' | 'unsub', topics: string[], ref = 0): { text: () => string } {
  return { text: () => JSON.stringify({ type, ref, topics }) };
}

type AdapterCall = { topic: string; emit: (frame: MuxFrameBody) => void; signal: AbortSignal };

function makeAdapter() {
  const calls: AdapterCall[] = [];
  const adapter = (topic: string, emit: AdapterCall['emit'], signal: AbortSignal) => {
    calls.push({ topic, emit, signal });
  };
  return { calls, adapter };
}

interface WireFrame {
  type: string;
  topic?: string;
  kind?: string;
  payload?: unknown;
  count?: number;
  ref?: number;
  ok?: boolean;
}

function parseWire(raw: string[]): WireFrame[] {
  return raw.map((line) => JSON.parse(line) as WireFrame);
}

function eventFrames(frames: WireFrame[]): WireFrame[] {
  return frames.filter((f) => f.type === 'event');
}

/** Feeds captured wire frames through the connection the same way socket dispatch does. */
function deliverToClient(frames: WireFrame[]): number {
  let heartbeats = 0;
  for (const frame of frames) {
    if (frame.type === 'ping') {
      heartbeats++;
      continue;
    }
    if (frame.type !== 'event' || typeof frame.topic !== 'string') continue;
    if (frame.kind === 'dropped') {
      act(() => {
        fakeMux.emitDropped(frame.topic as string, frame.count ?? 0);
      });
      continue;
    }
    if (frame.kind === 'data') {
      act(() => {
        fakeMux.emitWire(frame.topic as string, 'data', frame.payload);
      });
    }
  }
  return heartbeats;
}

beforeEach(() => {
  fakeMux.subscriptions.clear();
  fakeMux.status = { connected: false, error: null };
});

describe('slow consumer end to end: server write queue to client hook', () => {
  it('sheds bulk frames with correct dropped counts while control frames and heartbeats still arrive', async () => {
    const timeouts = mockSetTimeout();
    const intervals = mockSetInterval();
    const { calls, adapter } = makeAdapter();
    const h = createMuxWsHandlers({ topicAdapter: adapter });
    const peer = makePeer('slow-consumer');
    await h.open(peer as unknown as Peer);
    peer.bufferedAmount = 2 * 1024 * 1024;
    await h.message(peer as unknown as Peer, command('sub', ['stats:docker', 'inventory'], 1));

    calls[0].emit({ topic: 'stats:docker', kind: 'data', payload: [{ key: 'a-1', time: 1000, entity: 'a' }] });
    calls[0].emit({ topic: 'stats:docker', kind: 'data', payload: [{ key: 'a-2', time: 2000, entity: 'a' }] });
    calls[0].emit({ topic: 'stats:docker', kind: 'data', payload: [{ key: 'a-3', time: 3000, entity: 'a' }] });
    calls[1].emit({ topic: 'inventory', kind: 'data', payload: { rev: 1 } });
    calls[1].emit({ topic: 'inventory', kind: 'data', payload: { rev: 2 } });
    intervals.fireNext();
    timeouts.fireNext();
    const wire = parseWire([...peer.sentRaw]);
    h.close(peer as unknown as Peer);
    timeouts.restore();
    intervals.restore();

    const events = eventFrames(wire);
    expect(events.filter((f) => f.kind === 'data' && f.topic === 'stats:docker')).toHaveLength(0);
    expect(events.filter((f) => f.kind === 'data' && f.topic === 'inventory')).toEqual([
      { type: 'event', topic: 'inventory', kind: 'data', payload: { rev: 2 } },
    ]);
    expect(events.filter((f) => f.kind === 'dropped')).toEqual([
      { type: 'event', topic: 'stats:docker', kind: 'dropped', count: 3 },
    ]);
    expect(wire.filter((f) => f.type === 'ping')).toHaveLength(1);

    const controlRevs: number[] = [];
    const control = renderHook(() =>
      useMuxChannel(controlChannel, { onData: (e: { rev: number }) => controlRevs.push(e.rev) }),
    );
    const stats = renderHook(() =>
      useTimeSeriesStream({
        channel: statsChannel,
        preloadFn: mock(() => Promise.resolve([])),
        ...rowAccessors,
        windowSeconds: 60,
        updateIntervalMs: 20,
      }),
    );
    act(() => {
      fakeMux.setStatus({ connected: true, error: null });
    });

    const heartbeats = deliverToClient(wire);
    expect(heartbeats).toBe(1);
    expect(controlRevs).toEqual([2]);
    await waitFor(() => {
      expect(stats.result.current.dropCount).toBe(3);
      expect(stats.result.current.droppedEvents).toEqual([
        { topic: 'stats:docker', count: 3, at: expect.any(Number) },
      ]);
    });

    peer.bufferedAmount = 0;
    calls[0].emit({ topic: 'stats:docker', kind: 'data', payload: [{ key: 'a-4', time: 4000, entity: 'a' }] });
    calls[0].emit({ topic: 'stats:docker', kind: 'data', payload: [{ key: 'a-4', time: 4000, entity: 'a' }] });
    calls[1].emit({ topic: 'inventory', kind: 'data', payload: { rev: 3 } });
    const resumed = parseWire(peer.sentRaw.slice(wire.length));
    deliverToClient(resumed);

    expect(controlRevs).toEqual([2, 3]);
    await waitFor(() => {
      expect(stats.result.current.rows.map((r) => r.key)).toEqual(['a-4']);
    });
    expect(stats.result.current.dropCount).toBe(3);
    expect(stats.result.current.droppedEvents).toEqual([
      { topic: 'stats:docker', count: 3, at: expect.any(Number) },
    ]);

    control.unmount();
    stats.unmount();
  });
});
