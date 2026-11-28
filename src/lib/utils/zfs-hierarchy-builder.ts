import { ZFS_GROUP_KINDS, type ZfsGroupKind } from '@homelab-manager/agent/types/protocol';
import type {
  ZFSHierarchy,
  ZFSHostAggregatedStats,
  ZFSHostHierarchy,
  ZFSPoolNode,
  ZFSStatsRow,
  ZFSTreeNode,
} from '@/types/zfs';

const GROUP_PREFIX = '@';

/** A device or pool name as one entity path segment. File vdevs print their full path, so `/` must not split them. */
export function zfsEntitySegment(name: string): string {
  return name.replaceAll('%', '%25').replaceAll('/', '%2F').replaceAll(GROUP_PREFIX, '%40');
}

/** Encoded names never start with `@`, so a disk named `logs` cannot collide with the log device group. */
export function zfsGroupSegment(kind: ZfsGroupKind): string {
  return `${GROUP_PREFIX}${kind}`;
}

const ESCAPES: Readonly<Record<string, string>> = { '%25': '%', '%2F': '/', '%40': GROUP_PREFIX };

function decodeSegment(segment: string): string {
  return segment.replaceAll(/%(?:25|2F|40)/g, (escape) => ESCAPES[escape]);
}

function groupKind(segment: string): ZfsGroupKind | null {
  if (!segment.startsWith(GROUP_PREFIX)) return null;
  const kind = segment.slice(GROUP_PREFIX.length);
  return (ZFS_GROUP_KINDS as readonly string[]).includes(kind) ? (kind as ZfsGroupKind) : null;
}

/**
 * Keeps each host's newest sample only. Every row of one sample shares its time, so a pool that was
 * exported, or a device that was removed, drops out on the next sample instead of lingering until
 * its last row leaves the stream window.
 */
export function latestSampleRows(rows: Iterable<ZFSStatsRow>): ZFSStatsRow[] {
  const all = Array.from(rows);
  const latestByHost = new Map<string, number>();
  for (const row of all) {
    const latest = latestByHost.get(row.host);
    if (latest === undefined || row.time > latest) latestByHost.set(row.host, row.time);
  }
  return all.filter((row) => row.time === latestByHost.get(row.host));
}

function compareChildren(a: ZFSTreeNode, b: ZFSTreeNode): number {
  const aRank = a.group ? ZFS_GROUP_KINDS.indexOf(a.group) : -1;
  const bRank = b.group ? ZFS_GROUP_KINDS.indexOf(b.group) : -1;
  if (aRank !== bRank) return aRank - bRank;
  return a.name.localeCompare(b.name);
}

function sortTree(nodes: ZFSTreeNode[]): void {
  nodes.sort(compareChildren);
  for (const node of nodes) sortTree(node.children);
}

/** Places each device under the node whose entity is its own minus the last segment. */
function buildPools(host: string, rows: ZFSStatsRow[]): ZFSHierarchy {
  const pools: ZFSPoolNode[] = [];
  const nodes = new Map<string, ZFSPoolNode | ZFSTreeNode>();
  const devices: Array<{ parent: string; node: ZFSTreeNode }> = [];

  for (const row of rows) {
    const id = `${host}/${row.entity}`;
    if (row.entity_type === 'pool') {
      const pool: ZFSPoolNode = { id, name: row.pool, row, children: [] };
      pools.push(pool);
      nodes.set(row.entity, pool);
      continue;
    }
    if (row.entity_type === 'host' || row.entity_type === 'agent_outdated') continue;

    const slash = row.entity.lastIndexOf('/');
    if (slash <= 0) {
      console.warn('[buildZFSHostHierarchy] Device row without a parent:', id);
      continue;
    }
    const segment = row.entity.slice(slash + 1);
    const kind = row.entity_type === 'group' ? groupKind(segment) : null;
    if (row.entity_type === 'group' && !kind) {
      console.warn('[buildZFSHostHierarchy] Unknown device group:', id);
      continue;
    }
    const node: ZFSTreeNode = kind
      ? { id, name: kind, type: 'group', group: kind, row, children: [] }
      : { id, name: decodeSegment(segment), type: row.entity_type, row, children: [] };
    nodes.set(row.entity, node);
    devices.push({ parent: row.entity.slice(0, slash), node });
  }

  for (const { parent, node } of devices) {
    const parentNode = nodes.get(parent);
    if (parentNode) parentNode.children.push(node);
    else console.warn('[buildZFSHostHierarchy] Device row without a parent:', node.id);
  }

  pools.sort((a, b) => a.name.localeCompare(b.name));
  for (const pool of pools) sortTree(pool.children);
  return new Map(pools.map((pool) => [pool.name, pool]));
}

/** Pool lines are summed as zpool reports them: a pool's capacity already leaves out its cache and spare devices. */
function calculateHostAggregates(pools: ZFSHierarchy): ZFSHostAggregatedStats {
  const totals: ZFSHostAggregatedStats = {
    capacityAlloc: 0,
    capacityFree: 0,
    readOpsPerSec: 0,
    writeOpsPerSec: 0,
    readBytesPerSec: 0,
    writeBytesPerSec: 0,
    poolCount: pools.size,
  };
  for (const { row } of pools.values()) {
    totals.capacityAlloc += row.capacity_alloc ?? 0;
    totals.capacityFree += row.capacity_free ?? 0;
    totals.readOpsPerSec += row.read_ops_per_sec ?? 0;
    totals.writeOpsPerSec += row.write_ops_per_sec ?? 0;
    totals.readBytesPerSec += row.read_bytes_per_sec ?? 0;
    totals.writeBytesPerSec += row.write_bytes_per_sec ?? 0;
  }
  return totals;
}

/** Builds hosts -> pools -> devices from the newest sample of each host, sorted by host name. */
export function buildZFSHostHierarchy(rows: Iterable<ZFSStatsRow>): ZFSHostHierarchy {
  const rowsByHost = new Map<string, ZFSStatsRow[]>();
  for (const row of latestSampleRows(rows)) {
    const hostRows = rowsByHost.get(row.host);
    if (hostRows) hostRows.push(row);
    else rowsByHost.set(row.host, [row]);
  }

  const hosts = Array.from(rowsByHost.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hostName, hostRows]) => {
      const pools = buildPools(hostName, hostRows);
      return [hostName, {
        hostName,
        agentOutdated: hostRows.some((row) => row.entity_type === 'agent_outdated'),
        aggregated: calculateHostAggregates(pools),
        pools,
      }] as const;
    });
  return new Map(hosts);
}
