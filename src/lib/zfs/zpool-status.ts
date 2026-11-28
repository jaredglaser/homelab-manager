import { z } from 'zod';
import type { ZfsGroupKind } from '@/types/zfs';

/** A device in `zpool status -j --json-int` output, read only for layout, state and the error counters. */
export interface StatusDevice {
  name: string;
  /** False for leaf devices (disks, files). */
  hasChildren: boolean;
  /** `<type>-<id>` suffix of a non-leaf vdev, which `zpool_influxdb` names it by. Null for a leaf. */
  childId: string | null;
  path: string | null;
  state: string | null;
  allocBytes: string | null;
  totalBytes: string | null;
  readErrors: string | null;
  writeErrors: string | null;
  checksumErrors: string | null;
  children: StatusDevice[];
}

export interface StatusGroup {
  kind: ZfsGroupKind;
  devices: StatusDevice[];
}

export interface StatusPool {
  name: string;
  state: string | null;
  /** Data devices directly under the pool, in the order zpool lists them. */
  devices: StatusDevice[];
  groups: StatusGroup[];
}

type RawDevice = {
  name?: string;
  path?: string;
  state?: string;
  alloc_space?: number;
  total_space?: number;
  read_errors?: number;
  write_errors?: number;
  checksum_errors?: number;
  vdevs?: Record<string, RawDevice>;
};

const zCount = z.number().nonnegative();

const zRawDevice: z.ZodType<RawDevice> = z.lazy(() =>
  z.object({
    name: z.string().optional(),
    path: z.string().optional(),
    state: z.string().optional(),
    alloc_space: zCount.optional(),
    total_space: zCount.optional(),
    read_errors: zCount.optional(),
    write_errors: zCount.optional(),
    checksum_errors: zCount.optional(),
    vdevs: z.record(z.string(), zRawDevice).optional(),
  }),
);

const zDeviceMap = z.record(z.string(), zRawDevice);

const zRawPool = z.object({
  name: z.string().min(1),
  state: z.string().optional(),
  vdevs: zDeviceMap.optional(),
  special: zDeviceMap.optional(),
  dedup: zDeviceMap.optional(),
  logs: zDeviceMap.optional(),
  l2cache: zDeviceMap.optional(),
  spares: zDeviceMap.optional(),
});

const zZpoolStatus = z.object({
  pools: z.record(z.string(), zRawPool).optional(),
});

export class ZpoolStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZpoolStatusError';
  }
}

/** `--json-int` prints counts as JSON numbers, which lose digits past 2^53. That is a byte count of 8 PiB, so it is accepted. */
function countText(value: number | undefined): string | null {
  if (value === undefined) return null;
  return BigInt(Math.trunc(value)).toString();
}

function readDevice(key: string, raw: RawDevice): StatusDevice {
  const children = Object.entries(raw.vdevs ?? {}).map(([childKey, child]) => readDevice(childKey, child));
  const name = raw.name ?? key;
  const hasChildren = children.length > 0;
  const idMatch = /-(\d+)$/.exec(name);
  return {
    name,
    hasChildren,
    childId: hasChildren && idMatch ? idMatch[1] : null,
    path: raw.path ?? null,
    state: raw.state ?? null,
    allocBytes: countText(raw.alloc_space),
    totalBytes: countText(raw.total_space),
    readErrors: countText(raw.read_errors),
    writeErrors: countText(raw.write_errors),
    checksumErrors: countText(raw.checksum_errors),
    children,
  };
}

function readDevices(map: Record<string, RawDevice> | undefined): StatusDevice[] {
  return Object.entries(map ?? {}).map(([key, raw]) => readDevice(key, raw));
}

const GROUP_KEYS: ReadonlyArray<[ZfsGroupKind, 'special' | 'dedup' | 'logs' | 'l2cache' | 'spares']> = [
  ['special', 'special'],
  ['dedup', 'dedup'],
  ['logs', 'logs'],
  ['cache', 'l2cache'],
  ['spares', 'spares'],
];

/** Reads `zpool status -j --json-int`. Pools come back sorted by name. Throws `ZpoolStatusError` on output it cannot read. */
export function readZpoolStatus(stdout: string): StatusPool[] {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new ZpoolStatusError('zpool status printed something that is not JSON');
  }
  const parsed = zZpoolStatus.safeParse(json);
  if (!parsed.success) throw new ZpoolStatusError(`zpool status JSON has an unexpected shape: ${parsed.error.message}`);

  const pools = Object.values(parsed.data.pools ?? {}).map((raw): StatusPool => {
    const root = raw.vdevs?.[raw.name];
    const groups: StatusGroup[] = [];
    for (const [kind, key] of GROUP_KEYS) {
      const devices = readDevices(raw[key]);
      if (devices.length > 0) groups.push({ kind, devices });
    }
    return {
      name: raw.name,
      state: raw.state ?? null,
      devices: root ? readDevices(root.vdevs) : [],
      groups,
    };
  });
  return pools.sort((a, b) => a.name.localeCompare(b.name));
}
