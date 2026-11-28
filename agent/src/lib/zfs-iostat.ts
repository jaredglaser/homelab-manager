import { z } from 'zod';
import {
  ZFS_GROUP_KINDS,
  type ZfsCapacity,
  type ZfsDevice,
  type ZfsDeviceErrors,
  type ZfsDeviceHealth,
  type ZfsGroup,
  type ZfsGroupHealth,
  type ZfsGroupKind,
  type ZfsHealthState,
  type ZfsIo,
  type ZfsPool,
  type ZfsPoolHealth,
  type ZfsScan,
} from '../types/protocol';

/** No `-H`: it prints names unindented and drops the group header lines, so the tree is lost. `-y` keeps the since-import report out. */
export const ZPOOL_IOSTAT_ARGS = ['zpool', 'iostat', '-v', '-p', '-y', '1'];
/** `--json-int` prints counters and times as JSON numbers instead of scaled strings such as `1.2K`. */
export const ZPOOL_STATUS_ARGS = ['zpool', 'status', '-j', '--json-int'];

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

class IostatParseError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'IostatParseError';
  }
}

/** A line the parser could not place. `pool` is null for a line outside any pool. */
export interface IostatProblem {
  pool: string | null;
  reason: string;
  line: string;
}

export interface IostatSample {
  pools: ZfsPool[];
  problems: IostatProblem[];
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
  broken: boolean;
}

/** Stands in until the pool line's values are read, so a bad value still leaves a pool to mark broken. */
const NO_IO: ZfsIo = { readOps: 0, writeOps: 0, readBytes: 0, writeBytes: 0 };

function toRate(digits: string): number {
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) throw new IostatParseError('rate out of range');
  return value;
}

function parseDataLine(match: RegExpExecArray): Entry {
  const [, , name, alloc, free, readOps, writeOps, readBytes, writeBytes] = match;
  return {
    name,
    capacity: alloc === '0' && free === '0' ? null : { allocBytes: alloc, freeBytes: free },
    io: {
      readOps: toRate(readOps),
      writeOps: toRate(writeOps),
      readBytes: toRate(readBytes),
      writeBytes: toRate(writeBytes),
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
 * rows. A line it cannot place drops the pool it is in for this sample, since skipping only the
 * line would attach the devices after it to the wrong parent. The other pools are kept.
 */
export function parseIostatSample(lines: readonly string[]): IostatSample {
  const pools: PoolEntry[] = [];
  const problems: IostatProblem[] = [];
  let pool: PoolEntry | null = null;
  let target: Entry[] | null = null;
  const stack: Entry[] = [];

  const placeDevice = (indent: number, entry: Entry): void => {
    if (!pool || !target) throw new IostatParseError('device outside a pool');
    if (indent % 2 !== 0) throw new IostatParseError('odd indent');
    const depth = indent / 2;
    if (depth === 1) {
      target.push(entry);
    } else {
      const parent = stack[depth - 2];
      if (!parent || stack.length < depth - 1) throw new IostatParseError('device without a parent');
      parent.children.push(entry);
    }
    stack.length = depth - 1;
    stack.push(entry);
  };

  const openPool = (name: string): PoolEntry => {
    const opened: PoolEntry = { entry: { name, capacity: null, io: NO_IO, children: [] }, devices: [], groups: [], broken: false };
    pool = opened;
    pools.push(opened);
    target = opened.devices;
    stack.length = 0;
    return opened;
  };

  const placeLine = (line: string): void => {
    const data = DATA_LINE.exec(line);
    if (data && data[1].length === 0) {
      openPool(data[2]).entry = parseDataLine(data);
      return;
    }
    if (!data && !line.startsWith(' ') && !GROUP_HEADER.test(line)) {
      // Columns are two spaces apart, so the name is what comes before the first such gap.
      openPool(line.split(/\s{2,}/)[0]);
      throw new IostatParseError('unrecognized pool line');
    }
    if (pool?.broken) return;
    if (data) {
      placeDevice(data[1].length, parseDataLine(data));
      return;
    }

    const header = GROUP_HEADER.exec(line);
    const kind = header ? IOSTAT_GROUP_NAMES[header[1]] : undefined;
    if (!kind) throw new IostatParseError('unrecognized line');
    if (!pool) throw new IostatParseError('group outside a pool');
    const current: PoolEntry = pool;
    if (current.groups.some((group) => group.kind === kind)) throw new IostatParseError('repeated group');
    const group = { kind, members: [] as Entry[] };
    current.groups.push(group);
    target = group.members;
    stack.length = 0;
  };

  for (const line of lines) {
    if (line.trim() === '') continue;
    if (SEPARATOR.test(line)) {
      pool = null;
      target = null;
      continue;
    }
    try {
      placeLine(line);
    } catch (err) {
      if (!(err instanceof IostatParseError)) throw err;
      const current = pool as PoolEntry | null;
      if (current) current.broken = true;
      problems.push({ pool: current?.entry.name ?? null, reason: err.reason, line });
    }
  }

  return { pools: pools.filter((entry) => !entry.broken).map(toPool), problems };
}

const PROBLEM_LOG_INTERVAL_MS = 5 * 60_000;

/**
 * Splits the `zpool iostat` line stream into samples. A sample is only complete once the next
 * header arrives, so the one in progress when the process stops is dropped rather than sent short.
 */
export class IostatSampleReader {
  private lines: string[] | null = null;
  private startedAt = 0;
  /** A bad line repeats every second, so each pool and reason is logged at most once per interval. */
  private readonly lastLogged = new Map<string, number>();

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
    const { pools, problems } = parseIostatSample(this.lines);
    this.lines = null;
    for (const problem of problems) this.logProblem(problem);
    this.onSample(pools, this.startedAt);
  }

  private logProblem(problem: IostatProblem): void {
    const key = `${problem.pool ?? ''}\n${problem.reason}`;
    const last = this.lastLogged.get(key);
    if (last !== undefined && this.now() - last < PROBLEM_LOG_INTERVAL_MS) return;
    this.lastLogged.set(key, this.now());
    const where = problem.pool === null ? 'outside any pool' : `in pool ${problem.pool}, which is left out of the sample`;
    console.error(`Could not read a zpool iostat line ${where} (${problem.reason}): ${problem.line}`);
  }
}

const UNREPORTABLE_POOL_STATES = new Set(['FAULTED', 'UNAVAIL']);

const zZpoolStatusJson = z.object({
  pools: z.record(
    z.string(),
    z.object({
      state: z.string(),
      spares: z.record(z.string(), z.object({ name: z.string().min(1) })).optional(),
    }),
  ),
});

const zStatusNumber = z.number().nonnegative();

interface StatusVdevJson {
  name: string;
  state?: string;
  read_errors?: number;
  write_errors?: number;
  checksum_errors?: number;
  vdevs?: Record<string, StatusVdevJson>;
}

const zStatusVdevJson: z.ZodType<StatusVdevJson> = z.lazy(() => z.object({
  name: z.string().min(1),
  state: z.string().optional(),
  read_errors: zStatusNumber.optional(),
  write_errors: zStatusNumber.optional(),
  checksum_errors: zStatusNumber.optional(),
  vdevs: z.record(z.string(), zStatusVdevJson).optional(),
}));

const zStatusVdevMap = z.record(z.string(), zStatusVdevJson);

const zStatusScanJson = z.object({
  function: z.string(),
  state: z.string(),
  end_time: zStatusNumber,
  to_examine: zStatusNumber,
  skipped: zStatusNumber,
  issued: zStatusNumber,
  processed: zStatusNumber,
  errors: zStatusNumber,
  scrub_pause: zStatusNumber,
});

const zStatusPoolHealthJson = z.object({
  state: z.string(),
  vdevs: zStatusVdevMap.optional(),
  scan_stats: zStatusScanJson.optional(),
  special: zStatusVdevMap.optional(),
  dedup: zStatusVdevMap.optional(),
  logs: zStatusVdevMap.optional(),
  l2cache: zStatusVdevMap.optional(),
  spares: zStatusVdevMap.optional(),
});

type StatusPoolHealthJson = z.infer<typeof zStatusPoolHealthJson>;

/** The classes `zpool status -j` prints beside `vdevs`, by the group each is in the pool tree. */
const STATUS_GROUPS: Readonly<Record<ZfsGroupKind, (pool: StatusPoolHealthJson) => Record<string, StatusVdevJson> | undefined>> = {
  special: (pool) => pool.special,
  dedup: (pool) => pool.dedup,
  logs: (pool) => pool.logs,
  cache: (pool) => pool.l2cache,
  spares: (pool) => pool.spares,
};

const zZpoolStatusHealthJson = z.object({ pools: z.record(z.string(), zStatusPoolHealthJson) });

/**
 * Pool states come from libzfs `zpool_get_state_str`, device states from the `vdev_state_str` table in
 * zpool_main.c, which names an unopenable device CANT_OPEN, and a spare is AVAIL or INUSE instead.
 */
const HEALTH_STATES: Readonly<Record<string, ZfsHealthState>> = {
  ONLINE: 'online',
  DEGRADED: 'degraded',
  FAULTED: 'faulted',
  OFFLINE: 'offline',
  CLOSED: 'offline',
  REMOVED: 'removed',
  UNAVAIL: 'unavailable',
  CANT_OPEN: 'unavailable',
  SUSPENDED: 'suspended',
  AVAIL: 'online',
  INUSE: 'online',
};

function toHealthState(state: string | undefined): ZfsHealthState {
  return (state !== undefined && HEALTH_STATES[state]) || 'unknown';
}

/** JSON.parse rounds a uint64 past 2^53, and a counter at UINT64_MAX would fail the frame schema. */
function toCount(value: number): number {
  return Math.min(Math.trunc(value), Number.MAX_SAFE_INTEGER);
}

function toErrors(vdev: StatusVdevJson): ZfsDeviceErrors | null {
  const { read_errors: read, write_errors: write, checksum_errors: checksum } = vdev;
  if (read === undefined || write === undefined || checksum === undefined) return null;
  return { read: toCount(read), write: toCount(write), checksum: toCount(checksum) };
}

function toDeviceHealth(vdev: StatusVdevJson): ZfsDeviceHealth {
  const children = Object.values(vdev.vdevs ?? {}).map(toDeviceHealth);
  const base = { name: vdev.name, state: toHealthState(vdev.state), errors: toErrors(vdev) };
  return children.length > 0 ? { kind: 'vdev', ...base, children } : { kind: 'disk', ...base };
}

const SCAN_KINDS: Readonly<Record<string, ZfsScan['kind']>> = { SCRUB: 'scrub', RESILVER: 'resilver' };

function toScan(scan: z.infer<typeof zStatusScanJson> | undefined): ZfsScan | null {
  const kind = scan ? SCAN_KINDS[scan.function] : undefined;
  if (!scan || !kind) return null;
  let state: ZfsScan['state'];
  if (scan.state === 'SCANNING') state = scan.scrub_pause > 0 ? 'paused' : 'running';
  else if (scan.state === 'FINISHED') state = 'finished';
  else if (scan.state === 'CANCELED') state = 'canceled';
  else return null;

  const stopped = state === 'finished' || state === 'canceled';
  // zpool prints "% done" as issued over (to_examine - skipped).
  const total = scan.to_examine - scan.skipped;
  const percentDone = stopped ? null : Math.min(100, Math.max(0, total > 0 ? Math.floor((scan.issued * 100) / total) : 0));
  return {
    kind,
    state,
    percentDone,
    endedAt: stopped && scan.end_time > 0 ? toCount(scan.end_time * 1000) : null,
    repairedBytes: toCount(scan.processed),
    errors: toCount(scan.errors),
  };
}

function toPoolHealth(name: string, pool: StatusPoolHealthJson): ZfsPoolHealth {
  // The root vdev is keyed by the pool's own name, and its children are the pool's data devices.
  const roots = Object.values(pool.vdevs ?? {});
  const devices = roots.flatMap((root) => Object.values(root.vdevs ?? {}).map(toDeviceHealth));
  const groups: ZfsGroupHealth[] = ZFS_GROUP_KINDS.flatMap((group) => {
    const members = Object.values(STATUS_GROUPS[group](pool) ?? {});
    return members.length > 0 ? [{ kind: 'group' as const, group, children: members.map(toDeviceHealth) }] : [];
  });
  return { name, state: toHealthState(pool.state), scan: toScan(pool.scan_stats), children: [...devices, ...groups] };
}

export interface ZpoolStatusSummary {
  /** Every pool zpool status lists, reportable or not. */
  poolCount: number;
  /** Pools zpool iostat can report. It skips unavailable pools, which `zpool status` names FAULTED. */
  reportablePools: Set<string>;
  sparesByPool: Map<string, string[]>;
  /** Sorted by pool name. Null when the pools are listed but their health is not in the shape zpool 2.3 and later prints. */
  health: ZfsPoolHealth[] | null;
}

function readHealth(json: unknown): ZfsPoolHealth[] | null {
  const parsed = zZpoolStatusHealthJson.safeParse(json);
  if (!parsed.success) return null;
  return Object.entries(parsed.data.pools)
    .map(([name, pool]) => toPoolHealth(name, pool))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Reads `zpool status -j --json-int` output. Null when it is not the JSON zpool 2.3 and later prints. */
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
  return { poolCount: Object.keys(parsed.data.pools).length, reportablePools, sparesByPool, health: readHealth(json) };
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
