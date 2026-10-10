import { describe, it, expect } from 'bun:test';
import {
  INVENTORY_TOPIC,
  MAX_SUB_BATCH,
  isValidTopic,
  logsTopic,
  lookupTopicSpec,
  parseCommandFrame,
  parseLogsTopic,
  parseStatsTopic,
  statsTopic,
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

describe('stats topics', () => {
  it('round-trips source and topic', () => {
    expect(statsTopic('docker')).toBe('stats:docker');
    expect(statsTopic('zfs')).toBe('stats:zfs');
    expect(statsTopic('proxmox')).toBe('stats:proxmox');
    expect(parseStatsTopic('stats:docker')).toBe('docker');
    expect(parseStatsTopic('stats:zfs')).toBe('zfs');
    expect(parseStatsTopic('stats:proxmox')).toBe('proxmox');
  });

  it('rejects unknown sources and non-stats topics', () => {
    expect(parseStatsTopic('stats:bogus')).toBeNull();
    expect(parseStatsTopic('stats:')).toBeNull();
    expect(parseStatsTopic(INVENTORY_TOPIC)).toBeNull();
    expect(parseStatsTopic('logs:server1/abc123')).toBeNull();
  });
});

describe('lookupTopicSpec', () => {
  it('tags the stats topics as bulk', () => {
    expect(lookupTopicSpec('stats:docker')).toEqual({ class: 'bulk' });
    expect(lookupTopicSpec('stats:zfs')).toEqual({ class: 'bulk' });
    expect(lookupTopicSpec('stats:proxmox')).toEqual({ class: 'bulk' });
  });

  it('tags inventory as control and logs as bulk', () => {
    expect(lookupTopicSpec(INVENTORY_TOPIC)).toEqual({ class: 'control' });
    expect(lookupTopicSpec('logs:server1/abc123')).toEqual({ class: 'bulk' });
  });

  it('returns null for unregistered topics', () => {
    expect(lookupTopicSpec('stats:bogus')).toBeNull();
    expect(lookupTopicSpec('unknown')).toBeNull();
  });
});

describe('isValidTopic', () => {
  it('accepts inventory, well-formed logs topics, and the stats topics', () => {
    expect(isValidTopic(INVENTORY_TOPIC)).toBe(true);
    expect(isValidTopic('logs:server1/abc123')).toBe(true);
    expect(isValidTopic('stats:docker')).toBe(true);
    expect(isValidTopic('stats:zfs')).toBe(true);
    expect(isValidTopic('stats:proxmox')).toBe(true);
  });

  it('rejects unknown channels and non-strings', () => {
    expect(isValidTopic('stats:bogus')).toBe(false);
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

  it('parses commands over stats topics', () => {
    const frame = parseCommandFrame({ type: 'sub', ref: 1, topics: ['stats:docker', 'stats:zfs'] });
    expect(frame).toEqual({ type: 'sub', ref: 1, topics: ['stats:docker', 'stats:zfs'] });
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
