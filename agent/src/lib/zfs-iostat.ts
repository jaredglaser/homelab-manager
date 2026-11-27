import { z } from 'zod';
import type { ZfsCapacity, ZfsDevice, ZfsGroup, ZfsGroupKind, ZfsIo, ZfsPool } from '../types/protocol';

/** No `-H`: it prints names unindented and drops the group header lines, so the tree is lost. `-y` keeps the since-import report out. */
export const ZPOOL_IOSTAT_ARGS = ['zpool', 'iostat', '-v', '-p', '-y', '1'];
export const ZPOOL_STATUS_ARGS = ['zpool', 'status', '-j'];

const HEADER_TOP = /^\s+capacity\s+operations\s+bandwidth\s*$/;
const HEADER_LABELS = /^(?:pool|vdev)\s+alloc\s+free\s+read\s+write\s+read\s+write\s*$/;
const SEPARATOR = /^-+(?:\s+-+){6}\s*$/;
const GROUP_HEADER = /^(\S+)(?:\s+-){6}\s*$/;
const DATA_LINE = /^( *)(\S.*?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/;

/** zpool prints the dedup, special and log classes under these names, then L2ARC as `cache`. Spares never appear in iostat. */
const IOSTAT_GROUP_NAMES: Readonly<Record<string, ZfsGroupKind>> = {
  special: 'special',
  dedup: 'dedup',
  logs: 'logs',
  cache: 'cache',
};

export class IostatParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IostatParseError';
  }
}

interface Entry {
  name: string;
  capacity: ZfsCapacity | null;
  io: ZfsIo;
  children: Entry[];
}

interface PoolEntry {
  entry: Entry;
  devices: Entry[];
  groups: Array<{ kind: ZfsGroupKind; members: Entry[] }>;
}

function toRate(digits: string, line: string): number {
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) throw new IostatParseError(`rate out of range: ${line}`);
  return value;
}

function parseDataLine(match: RegExpExecArray, line: string): Entry {
  const [, , name, alloc, free, readOps, writeOps, readBytes, writeBytes] = match;
  return {
    name,
    capacity: alloc === '0' && free === '0' ? null : { allocBytes: alloc, freeBytes: free },
    io: {
      readOps: toRate(readOps, line),
      writeOps: toRate(writeOps, line),
      readBytes: toRate(readBytes, line),
      writeBytes: toRate(writeBytes, line),
    },
    children: [],
  };
}

function toDevice(entry: Entry): ZfsDevice {
  if (entry.children.length === 0) {
    return { kind: 'disk', name: entry.name, capacity: entry.capacity, io: entry.io };
  }
  return {
    kind: 'vdev',
    name: entry.name,
    capacity: entry.capacity,
    io: entry.io,
    children: entry.children.map(toDevice),
  };
}

function toPool({ entry, devices, groups }: PoolEntry): ZfsPool {
  const groupNodes: ZfsGroup[] = groups
    .filter((group) => group.members.length > 0)
    .map((group) => ({ kind: 'group', group: group.kind, children: group.members.map(toDevice) }));
  return {
    name: entry.name,
    capacity: entry.capacity ?? { allocBytes: '0', freeBytes: '0' },
    io: entry.io,
    children: [...devices.map(toDevice), ...groupNodes],
  };
}

/**
 * Builds the pool trees of one `zpool iostat -v -p` sample from its lines after the two header
 * rows. Throws `IostatParseError` on any line it cannot place, because a skipped line would
 * attach the devices after it to the wrong parent.
 */
export function parseIostatSample(lines: readonly string[]): ZfsPool[] {
  const pools: PoolEntry[] = [];
  let pool: PoolEntry | null = null;
  let target: Entry[] | null = null;
  const stack: Entry[] = [];

  for (const line of lines) {
    if (line.trim() === '') continue;
    if (SEPARATOR.test(line)) {
      pool = null;
      continue;
    }

    const data = DATA_LINE.exec(line);
    if (data) {
      const indent = data[1].length;
      const entry = parseDataLine(data, line);
      if (indent === 0) {
        pool = { entry, devices: [], groups: [] };
        pools.push(pool);
        target = pool.devices;
        stack.length = 0;
        continue;
      }
      if (!pool || !target) throw new IostatParseError(`device outside a pool: ${line}`);
      if (indent % 2 !== 0) throw new IostatParseError(`odd indent: ${line}`);
      const depth = indent / 2;
      if (depth === 1) {
        target.push(entry);
      } else {
        const parent = stack[depth - 2];
        if (!parent || stack.length < depth - 1) throw new IostatParseError(`device without a parent: ${line}`);
        parent.children.push(entry);
      }
      stack.length = depth - 1;
      stack.push(entry);
      continue;
    }

    const header = GROUP_HEADER.exec(line);
    const kind = header ? IOSTAT_GROUP_NAMES[header[1]] : undefined;
    if (kind && pool) {
      if (pool.groups.some((group) => group.kind === kind)) throw new IostatParseError(`repeated group: ${line}`);
      const group = { kind, members: [] as Entry[] };
      pool.groups.push(group);
      target = group.members;
      stack.length = 0;
      continue;
    }

    throw new IostatParseError(`unrecognized line: ${line}`);
  }

  return pools.map(toPool);
}

/**
 * Splits the `zpool iostat` line stream into samples. A sample is only complete once the next
 * header arrives, so the one in progress when the process stops is dropped rather than sent short.
 */
export class IostatSampleReader {
  private lines: string[] | null = null;
  private startedAt = 0;

  constructor(
    private readonly onSample: (pools: ZfsPool[], time: number) => void,
    private readonly now: () => number = Date.now,
  ) {}

  push(line: string): void {
    if (HEADER_TOP.test(line)) {
      this.flush();
      this.lines = [];
      this.startedAt = this.now();
      return;
    }
    if (this.lines === null || HEADER_LABELS.test(line)) return;
    this.lines.push(line);
  }

  private flush(): void {
    if (this.lines === null) return;
    const lines = this.lines;
    this.lines = null;
    let pools: ZfsPool[];
    try {
      pools = parseIostatSample(lines);
    } catch (err) {
      if (!(err instanceof IostatParseError)) throw err;
      console.error('Dropped a zpool iostat sample:', err.message);
      return;
    }
    this.onSample(pools, this.startedAt);
  }
}

const zZpoolStatusJson = z.object({
  pools: z.record(
    z.string(),
    z.object({
      state: z.string(),
      spares: z.record(z.string(), z.object({ name: z.string().min(1) })).optional(),
    }),
  ),
});

const UNREPORTABLE_POOL_STATES = new Set(['FAULTED', 'UNAVAIL']);

export interface ZpoolStatusSummary {
  /** Pools zpool iostat can report. It skips unavailable pools, which `zpool status` names FAULTED. */
  reportablePools: Set<string>;
  sparesByPool: Map<string, string[]>;
}

/** Reads `zpool status -j` output. Null when it is not the JSON zpool 2.3 prints. */
export function parseZpoolStatus(text: string): ZpoolStatusSummary | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = zZpoolStatusJson.safeParse(json);
  if (!parsed.success) return null;

  const reportablePools = new Set<string>();
  const sparesByPool = new Map<string, string[]>();
  for (const [name, pool] of Object.entries(parsed.data.pools)) {
    if (!UNREPORTABLE_POOL_STATES.has(pool.state)) reportablePools.add(name);
    const spares = Object.values(pool.spares ?? {}).map((spare) => spare.name);
    if (spares.length > 0) sparesByPool.set(name, spares.sort((a, b) => a.localeCompare(b)));
  }
  return { reportablePools, sparesByPool };
}

export function withSpares(pools: ZfsPool[], sparesByPool: ReadonlyMap<string, string[]>): ZfsPool[] {
  return pools.map((pool) => {
    const spares = sparesByPool.get(pool.name);
    if (!spares) return pool;
    const group: ZfsGroup = {
      kind: 'group',
      group: 'spares',
      children: spares.map((name) => ({ kind: 'disk', name, capacity: null, io: null })),
    };
    return { ...pool, children: [...pool.children, group] };
  });
}
