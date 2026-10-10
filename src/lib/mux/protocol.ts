/**
 * Wire protocol for the /api/mux WebSocket. One socket carries every live
 * topic (inventory, logs:<host>/<containerId>) with runtime subscribe and
 * unsubscribe commands.
 *
 * Client to server: { type: 'sub' | 'unsub', ref, topics }. Each command
 * frame carries at most MAX_SUB_BATCH (sub) or MAX_UNSUB_BATCH (unsub)
 * topics, and clients split larger bursts into batches. Frames that fail
 * parseCommandFrame are answered with { type: 'ack', ref: 0, ok: false,
 * error: 'Invalid command' }. Unparseable text is dropped without a reply.
 *
 * Server to client. Every well-formed command frame is answered with
 * exactly one ack:
 * - { type: 'ack', ref, ok: true } confirms the command.
 * - { type: 'ack', ref, ok: false, error?, code? } rejects it. error is
 *   renderable text. code is a stable machine-readable reason, currently
 *   TOPIC_LIMIT_ERROR_CODE ('topic_limit'), for clients to branch on.
 * - { type: 'event', topic, kind, payload } streams topic data. kind is
 *   'data', 'backlog_start', 'backlog_done', 'stream_end', or 'error'.
 * - { type: 'ping' } is a server keepalive.
 *
 * Sessions hold at most MAX_SESSION_TOPICS (250) topics. That limit is a
 * circuit breaker against runaway scripted clients and replaces the old
 * 20-topic hard cap. A subscribe batch that would exceed the budget is
 * rejected whole with code 'topic_limit' while the session and its existing
 * subscriptions stay running. Unsubscribes free budget.
 *
 * Topic-limit rejections are surfaced in the UI: MuxConnection toasts the
 * ack error and routes per-topic failure into subscriber error state.
 */
export const INVENTORY_TOPIC = 'inventory';
export const SETTINGS_TOPIC = 'settings';
export const STACK_STATUS_TOPIC = 'stack-status';

export const MAX_SESSION_TOPICS = 250;
export const MAX_SUB_BATCH = 30;
export const MAX_UNSUB_BATCH = 50;
export const TOPIC_LIMIT_ERROR_CODE = 'topic_limit';

const HOST_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const CONTAINER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const LOGS_TOPIC_PREFIX = 'logs:';
const STATS_TOPIC_PREFIX = 'stats:';
const STATS_SOURCES = ['docker', 'zfs', 'proxmox'] as const;

export type StatsTopicSource = (typeof STATS_SOURCES)[number];

export type MuxEventKind = 'data' | 'backlog_start' | 'backlog_done' | 'stream_end' | 'error' | 'dropped';

export type MuxTopicClass = 'control' | 'bulk';

export interface MuxTopicSpec {
  class: MuxTopicClass;
}

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
  code?: string;
}

export interface MuxEventFrame {
  type: 'event';
  topic: string;
  kind: Exclude<MuxEventKind, 'dropped'>;
  payload: unknown;
}

export interface MuxDroppedFrame {
  type: 'event';
  topic: string;
  kind: 'dropped';
  count: number;
}

export type MuxTopicFrame = MuxEventFrame | MuxDroppedFrame;

export type MuxFrameBody = Omit<MuxEventFrame, 'type'> | Omit<MuxDroppedFrame, 'type'>;

export interface MuxPingFrame {
  type: 'ping';
}

export type MuxServerFrame = MuxAckFrame | MuxTopicFrame | MuxPingFrame;

export function logsTopic(host: string, containerId: string): string {
  return `${LOGS_TOPIC_PREFIX}${host}/${containerId}`;
}

export function parseLogsTopic(topic: string): { host: string; containerId: string } | null {
  if (!topic.startsWith(LOGS_TOPIC_PREFIX)) return null;
  const key = topic.slice(LOGS_TOPIC_PREFIX.length);
  const slash = key.indexOf('/');
  if (slash <= 0 || slash === key.length - 1) return null;
  const host = key.slice(0, slash);
  const containerId = key.slice(slash + 1);
  if (!HOST_PATTERN.test(host) || !CONTAINER_ID_PATTERN.test(containerId)) return null;
  return { host, containerId };
}

export function statsTopic(source: StatsTopicSource): string {
  return `${STATS_TOPIC_PREFIX}${source}`;
}

export function parseStatsTopic(topic: string): StatsTopicSource | null {
  if (!topic.startsWith(STATS_TOPIC_PREFIX)) return null;
  const source = topic.slice(STATS_TOPIC_PREFIX.length);
  return (STATS_SOURCES as readonly string[]).includes(source) ? (source as StatsTopicSource) : null;
}

const TOPIC_REGISTRY = new Map<string, MuxTopicSpec>([
  [INVENTORY_TOPIC, { class: 'control' }],
  [SETTINGS_TOPIC, { class: 'control' }],
  [STACK_STATUS_TOPIC, { class: 'control' }],
  [statsTopic('docker'), { class: 'bulk' }],
  [statsTopic('zfs'), { class: 'bulk' }],
  [statsTopic('proxmox'), { class: 'bulk' }],
]);

export function lookupTopicSpec(topic: string): MuxTopicSpec | null {
  const spec = TOPIC_REGISTRY.get(topic);
  if (spec) return spec;
  return parseLogsTopic(topic) !== null ? { class: 'bulk' } : null;
}

export function isValidTopic(topic: unknown): topic is string {
  return typeof topic === 'string' && lookupTopicSpec(topic) !== null;
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
