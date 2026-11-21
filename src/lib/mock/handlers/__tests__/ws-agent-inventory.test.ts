import { describe, it, expect, afterEach } from 'bun:test';

import { createConnectionHandler, type MuxMockClient } from '@/lib/mock/handlers/ws';
import { zAgentInventorySnapshotWire } from '@/lib/channels/agent-inventory';

interface MuxFrame {
  type: string;
  topic?: string;
  kind?: string;
  payload?: unknown;
  ref?: number;
  ok?: boolean;
}

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

describe('mock mux ws agent-inventory topic', () => {
  it('serves an agent inventory snapshot on subscribe', async () => {
    const c = connect();
    c.command('sub', ['agent-inventory']);

    for (let i = 0; i < 50 && c.dataFrames('agent-inventory').length === 0; i++) {
      await Bun.sleep(5);
    }

    const frames = c.dataFrames('agent-inventory');
    expect(frames.length).toBeGreaterThan(0);
    const payload = zAgentInventorySnapshotWire.parse(frames[0]!.payload);
    expect(payload.entries.length).toBeGreaterThan(0);
    expect(typeof payload.sweptAt).toBe('string');

    c.command('unsub', ['agent-inventory']);
    const count = c.dataFrames('agent-inventory').length;
    await Bun.sleep(20);
    expect(c.dataFrames('agent-inventory').length).toBe(count);
  });
});
