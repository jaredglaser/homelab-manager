import type { NewZFSStat } from '@/lib/database/repositories/stats-repository';
import { zfsEntitySegment, zfsGroupSegment } from '@/lib/utils/zfs-hierarchy-builder';
import type { ZFSEntityType } from '@/types/zfs';
import type { ZpoolStatsLine } from '@/lib/zfs/zpool-influxdb';
import type { StatusDevice, StatusPool } from '@/lib/zfs/zpool-status';

interface Rates {
  readOpsPerSec: number;
  writeOpsPerSec: number;
  readBytesPerSec: number;
  writeBytesPerSec: number;
}

interface CounterSample {
  timestampNs: bigint;
  readOps: bigint;
  writeOps: bigint;
  readBytes: bigint;
  writeBytes: bigint;
}

/** A device's first sample, and any whose counters went backwards (reboot, export and import), is blank. */
export class ZfsCounterTracker {
  private readonly previous = new Map<string, CounterSample>();

  rates(line: ZpoolStatsLine): Rates | null {
    const key = `${line.pool}\u0000${line.vdev}\u0000${line.path ?? ''}`;
    const prev = this.previous.get(key);
    this.previous.set(key, line);
    if (!prev) return null;
    const elapsedNs = line.timestampNs - prev.timestampNs;
    if (elapsedNs <= 0n) return null;
    const deltas = [
      line.readOps - prev.readOps,
      line.writeOps - prev.writeOps,
      line.readBytes - prev.readBytes,
      line.writeBytes - prev.writeBytes,
    ];
    if (deltas.some((delta) => delta < 0n)) return null;
    const seconds = Number(elapsedNs) / 1e9;
    const [readOps, writeOps, readBytes, writeBytes] = deltas.map((delta) => Number(delta) / seconds);
    return { readOpsPerSec: readOps, writeOpsPerSec: writeOps, readBytesPerSec: readBytes, writeBytesPerSec: writeBytes };
  }
}

/** The key a `zpool_influxdb` vdev tag resolves to: `/id:<n>` per non-leaf segment, `/path:<path>` for the leaf. */
export function influxDeviceKey(vdev: string, path: string | null): string | null {
  const segments = vdev.split('/');
  if (segments[0] !== 'root') return null;
  let key = '';
  for (let i = 1; i < segments.length; i++) {
    if (i === segments.length - 1 && path !== null) {
      key += `/path:${path}`;
      continue;
    }
    const id = /-(\d+)$/.exec(segments[i]);
    if (!id) return null;
    key += `/id:${id[1]}`;
  }
  return key;
}

interface LayoutNode {
  entity: string;
  entityType: ZFSEntityType;
  depth: number;
  /** Capacity is reported for pools and their top-level devices only. */
  topLevel: boolean;
  device: StatusDevice | null;
}

function statusKey(parentKey: string, device: StatusDevice): string | null {
  if (device.hasChildren) return device.childId === null ? null : `${parentKey}/id:${device.childId}`;
  return device.path === null ? null : `${parentKey}/path:${device.path}`;
}

/** Cache and spare devices never appear in `zpool_influxdb`, so their keys sit under a prefix no tag resolves to. */
const STATUS_ONLY_PREFIX = '!';

function indexLayout(pool: StatusPool): { nodes: LayoutNode[]; byKey: Map<string, LayoutNode> } {
  const poolEntity = zfsEntitySegment(pool.name);
  const nodes: LayoutNode[] = [];
  const byKey = new Map<string, LayoutNode>();
  let unkeyed = 0;

  const add = (device: StatusDevice, parentEntity: string, parentKey: string, depth: number, topLevel: boolean): void => {
    const entity = `${parentEntity}/${zfsEntitySegment(device.name)}`;
    const node: LayoutNode = { entity, entityType: device.hasChildren ? 'vdev' : 'disk', depth, topLevel, device };
    nodes.push(node);
    const key = statusKey(parentKey, device) ?? `${STATUS_ONLY_PREFIX}unkeyed-${unkeyed++}`;
    byKey.set(key, node);
    for (const child of device.children) add(child, entity, key, depth + 1, false);
  };

  for (const device of pool.devices) add(device, poolEntity, '', 1, true);
  for (const group of pool.groups) {
    const groupEntity = `${poolEntity}/${zfsGroupSegment(group.kind)}`;
    nodes.push({ entity: groupEntity, entityType: 'group', depth: 1, topLevel: false, device: null });
    const statusOnly = group.kind === 'cache' || group.kind === 'spares';
    const parentKey = statusOnly ? `${STATUS_ONLY_PREFIX}${group.kind}` : '';
    for (const device of group.devices) add(device, groupEntity, parentKey, 2, true);
  }
  return { nodes, byKey };
}

function freeBytes(device: Pick<StatusDevice, 'allocBytes' | 'totalBytes'>): string | null {
  if (device.allocBytes === null || device.totalBytes === null) return null;
  const free = BigInt(device.totalBytes) - BigInt(device.allocBytes);
  return free < 0n ? '0' : free.toString();
}

function row(
  base: { time: Date; host: string; pool: string },
  entity: string,
  entityType: ZFSEntityType,
  depth: number,
  values: Partial<Omit<NewZFSStat, 'time' | 'host' | 'pool' | 'entity' | 'entityType' | 'indent'>> = {},
): NewZFSStat {
  return {
    ...base,
    entity,
    entityType,
    indent: depth * 2,
    capacityAllocBytes: null,
    capacityFreeBytes: null,
    readOpsPerSec: null,
    writeOpsPerSec: null,
    readBytesPerSec: null,
    writeBytesPerSec: null,
    state: null,
    readErrors: null,
    writeErrors: null,
    checksumErrors: null,
    ...values,
  };
}

function lineValues(line: ZpoolStatsLine, rates: Rates | null, withCapacity: boolean) {
  return {
    ...(withCapacity ? { capacityAllocBytes: line.allocBytes.toString(), capacityFreeBytes: line.freeBytes.toString() } : {}),
    ...(rates ?? {}),
    state: line.state,
    readErrors: line.readErrors.toString(),
    writeErrors: line.writeErrors.toString(),
    checksumErrors: line.checksumErrors.toString(),
  };
}

export interface ZfsSampleInput {
  host: string;
  /** Worker clock: every row of a sample shares it, so the page reads the sample as one. */
  time: Date;
  lines: ZpoolStatsLine[];
  /** Latest `zpool status` layout, or null before the first one arrived. */
  layout: StatusPool[] | null;
  tracker: ZfsCounterTracker;
}

/** A node with no pools gets one `host` row per sample, so its newest sample still moves on. */
export function buildZfsSampleRows({ host, time, lines, layout, tracker }: ZfsSampleInput): NewZFSStat[] {
  const linesByPool = new Map<string, ZpoolStatsLine[]>();
  for (const line of lines) {
    const poolLines = linesByPool.get(line.pool);
    if (poolLines) poolLines.push(line);
    else linesByPool.set(line.pool, [line]);
  }
  if (linesByPool.size === 0 && (layout ?? []).length === 0) return [row({ time, host, pool: '' }, '', 'host', 0)];

  const rows: NewZFSStat[] = [];
  const written = new Set<string>();
  for (const [poolName, poolLines] of [...linesByPool.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const base = { time, host, pool: poolName };
    const byKey = new Map<string, ZpoolStatsLine>();
    for (const line of poolLines) {
      const key = influxDeviceKey(line.vdev, line.path);
      if (key !== null) byKey.set(key, line);
    }
    const rootLine = byKey.get('');
    if (!rootLine) continue;
    written.add(poolName);
    rows.push(row(base, zfsEntitySegment(poolName), 'pool', 0, lineValues(rootLine, tracker.rates(rootLine), true)));

    const poolLayout = layout?.find((pool) => pool.name === poolName);
    if (poolLayout) rows.push(...deviceRows(base, poolLayout, byKey, tracker));
  }
  for (const pool of layout ?? []) {
    if (written.has(pool.name)) continue;
    const base = { time, host, pool: pool.name };
    rows.push(row(base, zfsEntitySegment(pool.name), 'pool', 0, {
      ...(pool.allocBytes !== null && pool.totalBytes !== null
        ? { capacityAllocBytes: pool.allocBytes, capacityFreeBytes: freeBytes({ allocBytes: pool.allocBytes, totalBytes: pool.totalBytes }) }
        : {}),
      state: pool.state,
    }));
    rows.push(...deviceRows(base, pool, new Map(), tracker));
  }
  return rows.sort((a, b) => a.pool.localeCompare(b.pool));
}

function deviceRows(
  base: { time: Date; host: string; pool: string },
  poolLayout: StatusPool,
  byKey: Map<string, ZpoolStatsLine>,
  tracker: ZfsCounterTracker,
): NewZFSStat[] {
  const rows: NewZFSStat[] = [];
  const { nodes, byKey: layoutByKey } = indexLayout(poolLayout);
  const lineByNode = new Map<LayoutNode, ZpoolStatsLine>();
  for (const [key, node] of layoutByKey) {
    const line = byKey.get(key);
    if (line) lineByNode.set(node, line);
  }
  for (const node of nodes) {
    const line = lineByNode.get(node);
    if (line) {
      rows.push(row(base, node.entity, node.entityType, node.depth, lineValues(line, tracker.rates(line), node.topLevel)));
      continue;
    }
    const device = node.device;
    rows.push(row(base, node.entity, node.entityType, node.depth, device ? {
      ...(node.topLevel && device.allocBytes !== null ? { capacityAllocBytes: device.allocBytes, capacityFreeBytes: freeBytes(device) } : {}),
      state: device.state,
      readErrors: device.readErrors,
      writeErrors: device.writeErrors,
      checksumErrors: device.checksumErrors,
    } : {}));
  }
  return rows;
}
