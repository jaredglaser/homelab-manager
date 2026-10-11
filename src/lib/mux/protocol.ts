export const INVENTORY_TOPIC = 'inventory';

export const MAX_SESSION_TOPICS = 20;
export const MAX_SUB_BATCH = 30;
export const MAX_UNSUB_BATCH = 50;

const HOST_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const CONTAINER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export type MuxEventKind = 'data' | 'backlog_start' | 'backlog_done' | 'stream_end' | 'error';

export interface MuxCommandFrame {
  type: 'sub' | 'unsub';
  ref: number;
  topics: string[];
}

export interface MuxAckFrame {
  type: 'ack';
  ref: number;
  ok: boolean;
  error?: string;
}

export interface MuxEventFrame {
  type: 'event';
  topic: string;
  kind: MuxEventKind;
  payload: unknown;
}

export interface MuxPingFrame {
  type: 'ping';
}

export type MuxServerFrame = MuxAckFrame | MuxEventFrame | MuxPingFrame;

export function logsTopic(host: string, containerId: string): string {
  return `logs:${host}/${containerId}`;
}

export function parseLogsTopic(topic: string): { host: string; containerId: string } | null {
  if (!topic.startsWith('logs:')) return null;
  const key = topic.slice('logs:'.length);
  const slash = key.indexOf('/');
  if (slash <= 0 || slash === key.length - 1) return null;
  const host = key.slice(0, slash);
  const containerId = key.slice(slash + 1);
  if (!HOST_PATTERN.test(host) || !CONTAINER_ID_PATTERN.test(containerId)) return null;
  return { host, containerId };
}

export function isValidTopic(topic: unknown): topic is string {
  if (typeof topic !== 'string') return false;
  return topic === INVENTORY_TOPIC || parseLogsTopic(topic) !== null;
}

export function parseCommandFrame(raw: unknown): MuxCommandFrame | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const frame = raw as Record<string, unknown>;
  if (frame.type !== 'sub' && frame.type !== 'unsub') return null;
  if (typeof frame.ref !== 'number' || !Number.isInteger(frame.ref) || frame.ref < 0) return null;
  const { topics } = frame;
  if (!Array.isArray(topics) || topics.length === 0) return null;
  const max = frame.type === 'sub' ? MAX_SUB_BATCH : MAX_UNSUB_BATCH;
  if (topics.length > max) return null;
  if (!topics.every(isValidTopic)) return null;
  return { type: frame.type, ref: frame.ref, topics: topics as string[] };
}
