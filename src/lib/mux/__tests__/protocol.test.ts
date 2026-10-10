import { describe, it, expect } from 'bun:test';
import {
  INVENTORY_TOPIC,
  MAX_SUB_BATCH,
  isValidTopic,
  logsTopic,
  parseCommandFrame,
  parseLogsTopic,
} from '@/lib/mux/protocol';

describe('parseLogsTopic', () => {
  it('round-trips host and containerId', () => {
    const topic = logsTopic('server1', 'abc123');
    expect(topic).toBe('logs:server1/abc123');
    expect(parseLogsTopic(topic)).toEqual({ host: 'server1', containerId: 'abc123' });
  });

  it('rejects non-logs topics', () => {
    expect(parseLogsTopic(INVENTORY_TOPIC)).toBeNull();
    expect(parseLogsTopic('logs:no-slash')).toBeNull();
    expect(parseLogsTopic('logs:/abc')).toBeNull();
    expect(parseLogsTopic('logs:server/')).toBeNull();
    expect(parseLogsTopic('logs:server/..')).toBeNull();
    expect(parseLogsTopic('logs:ser ver/abc')).toBeNull();
    expect(parseLogsTopic('logs:server/a/b')).toBeNull();
  });
});

describe('isValidTopic', () => {
  it('accepts inventory and well-formed logs topics', () => {
    expect(isValidTopic(INVENTORY_TOPIC)).toBe(true);
    expect(isValidTopic('logs:server1/abc123')).toBe(true);
  });

  it('accepts the settings and stack-status control topics', () => {
    expect(isValidTopic('settings')).toBe(true);
    expect(isValidTopic('stack-status')).toBe(true);
  });

  it('rejects unknown channels and non-strings', () => {
    expect(isValidTopic('stats:docker')).toBe(false);
    expect(isValidTopic('logs:')).toBe(false);
    expect(isValidTopic(42)).toBe(false);
  });
});

describe('parseCommandFrame', () => {
  it('parses a valid sub command', () => {
    const frame = parseCommandFrame({ type: 'sub', ref: 3, topics: [INVENTORY_TOPIC, 'logs:s/abc'] });
    expect(frame).toEqual({ type: 'sub', ref: 3, topics: [INVENTORY_TOPIC, 'logs:s/abc'] });
  });

  it('parses a valid unsub command', () => {
    const frame = parseCommandFrame({ type: 'unsub', ref: 0, topics: [INVENTORY_TOPIC] });
    expect(frame?.type).toBe('unsub');
  });

  it('rejects malformed commands', () => {
    expect(parseCommandFrame(null)).toBeNull();
    expect(parseCommandFrame('sub')).toBeNull();
    expect(parseCommandFrame({ type: 'nope', ref: 0, topics: [INVENTORY_TOPIC] })).toBeNull();
    expect(parseCommandFrame({ type: 'sub', ref: -1, topics: [INVENTORY_TOPIC] })).toBeNull();
    expect(parseCommandFrame({ type: 'sub', ref: 1.5, topics: [INVENTORY_TOPIC] })).toBeNull();
    expect(parseCommandFrame({ type: 'sub', ref: 0, topics: [] })).toBeNull();
    expect(parseCommandFrame({ type: 'sub', ref: 0, topics: 'inventory' })).toBeNull();
    expect(parseCommandFrame({ type: 'sub', ref: 0, topics: ['bogus'] })).toBeNull();
  });

  it('rejects oversized batches', () => {
    const topics = Array.from({ length: MAX_SUB_BATCH + 1 }, () => INVENTORY_TOPIC);
    expect(parseCommandFrame({ type: 'sub', ref: 0, topics })).toBeNull();
  });
});
