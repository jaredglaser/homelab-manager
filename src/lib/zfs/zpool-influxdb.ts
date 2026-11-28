/** One `zpool_stats` line of `zpool_influxdb`: a pool (`vdev=root`), a vdev or a leaf device, with cumulative counters. */
export interface ZpoolStatsLine {
  pool: string;
  /** `root`, or `root/<type>-<id>/...` as `get_vdev_name` builds it. */
  vdev: string;
  /** Set on leaf devices only. */
  path: string | null;
  state: string;
  /** Node clock, nanoseconds. Each pool is stamped once, so every line of a pool shares it. */
  timestampNs: bigint;
  allocBytes: bigint;
  freeBytes: bigint;
  readOps: bigint;
  writeOps: bigint;
  readBytes: bigint;
  writeBytes: bigint;
  readErrors: bigint;
  writeErrors: bigint;
  checksumErrors: bigint;
}

export type InfluxLine =
  | { kind: 'stats'; line: ZpoolStatsLine }
  /** A measurement this reader does not use, such as `zpool_scan_stats` or `zpool_vdev_stats`. */
  | { kind: 'other' }
  | { kind: 'malformed'; reason: string };

const STATS_MEASUREMENT = 'zpool_stats';

/** Splits on `separator` where it is not escaped with a backslash, keeping the escapes for `unescape`. */
function splitUnescaped(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\' && i + 1 < text.length) {
      current += char + text[i + 1];
      i++;
      continue;
    }
    if (char === separator) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function unescape(text: string): string {
  return text.replaceAll(/\\(.)/g, '$1');
}

function splitPair(pair: string): [string, string] | null {
  const [key, ...rest] = splitUnescaped(pair, '=');
  if (key === undefined || rest.length !== 1 || key === '') return null;
  return [unescape(key), rest[0]];
}

/** `zpool_influxdb` prints counters as unsigned integers with a `u` suffix (`i` under `--signed-int`). */
function readCounter(fields: Map<string, string>, name: string): bigint | null {
  const raw = fields.get(name);
  if (raw === undefined) return null;
  const match = /^(\d+)[ui]$/.exec(raw);
  return match ? BigInt(match[1]) : null;
}

const COUNTERS = {
  allocBytes: 'alloc',
  freeBytes: 'free',
  readOps: 'read_ops',
  writeOps: 'write_ops',
  readBytes: 'read_bytes',
  writeBytes: 'write_bytes',
  readErrors: 'read_errors',
  writeErrors: 'write_errors',
  checksumErrors: 'checksum_errors',
} as const;

/** Reads one line of InfluxDB line protocol as `zpool_influxdb` prints it. Fields it does not use are ignored, so a newer release that adds one still parses. */
export function parseInfluxLine(raw: string): InfluxLine {
  const text = raw.trimEnd();
  const sections = splitUnescaped(text, ' ');
  if (sections.length !== 3) return { kind: 'malformed', reason: `expected 3 sections, found ${sections.length}` };
  const [series, fieldSet, timestamp] = sections;

  const [measurement, ...tagPairs] = splitUnescaped(series, ',');
  if (unescape(measurement) !== STATS_MEASUREMENT) return { kind: 'other' };

  const tags = new Map<string, string>();
  for (const pair of tagPairs) {
    const parsed = splitPair(pair);
    if (!parsed) return { kind: 'malformed', reason: 'unreadable tag' };
    tags.set(parsed[0], unescape(parsed[1]));
  }
  const fields = new Map<string, string>();
  for (const pair of splitUnescaped(fieldSet, ',')) {
    const parsed = splitPair(pair);
    if (!parsed) return { kind: 'malformed', reason: 'unreadable field' };
    fields.set(parsed[0], parsed[1]);
  }
  if (!/^\d+$/.test(timestamp)) return { kind: 'malformed', reason: 'unreadable timestamp' };

  const pool = tags.get('name');
  const vdev = tags.get('vdev');
  const state = tags.get('state');
  if (!pool || !vdev || !state) return { kind: 'malformed', reason: 'missing name, vdev or state tag' };

  const counters = {} as Record<keyof typeof COUNTERS, bigint>;
  for (const [key, field] of Object.entries(COUNTERS) as [keyof typeof COUNTERS, string][]) {
    const value = readCounter(fields, field);
    if (value === null) return { kind: 'malformed', reason: `missing or unreadable ${field}` };
    counters[key] = value;
  }

  return {
    kind: 'stats',
    line: {
      pool,
      vdev,
      path: tags.get('path') ?? null,
      state,
      timestampNs: BigInt(timestamp),
      ...counters,
    },
  };
}
