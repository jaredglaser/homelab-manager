import { atom, type WritableAtom } from 'jotai';

const STORAGE_PREFIX = 'homelab-layout/v1/';

export const BROWSER_LAYOUT_KEYS = {
  dockerCollapsedHosts: 'docker/collapsedHosts',
  dockerExpandedContainers: 'docker/expandedContainers',
  dockerContainerShells: 'docker/containerShells',
  stacksExpandedStacks: 'stacks/expandedStacks',
  zfsExpandedHosts: 'zfs/expandedHosts',
  zfsExpandedPools: 'zfs/expandedPools',
  zfsExpandedVdevs: 'zfs/expandedVdevs',
  proxmoxCollapsedHosts: 'proxmox/collapsedHosts',
  proxmoxCollapsedSections: 'proxmox/collapsedSections',
} as const;

export type BrowserLayoutKey = (typeof BROWSER_LAYOUT_KEYS)[keyof typeof BROWSER_LAYOUT_KEYS];

export function browserLayoutStorageKey(key: BrowserLayoutKey): string {
  return `${STORAGE_PREFIX}${key}`;
}

function readStored(storageKey: string): unknown {
  try {
    const raw = localStorage.getItem(storageKey);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function writeStored(storageKey: string, value: unknown): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // Blocked or full storage: the atom still holds the value for this session.
  }
}

type BrowserLayoutAtom<T> = WritableAtom<T, [update: (prev: T) => T], void>;

interface Codec<T> {
  fallback: () => T;
  decode: (stored: unknown) => T | undefined;
  encode: (value: T) => unknown;
}

/** A per-browser layout value, read from localStorage once per store and written back on every update. */
function browserLayoutAtom<T>(key: BrowserLayoutKey, codec: Codec<T>): BrowserLayoutAtom<T> {
  const storageKey = browserLayoutStorageKey(key);
  const UNREAD = Symbol('unread');
  const local = atom<T | typeof UNREAD>(UNREAD);
  const layout: BrowserLayoutAtom<T> = atom(
    (get) => {
      const value = get(local);
      if (value !== UNREAD) return value;
      return codec.decode(readStored(storageKey)) ?? codec.fallback();
    },
    (get, set, update) => {
      const next = update(get(layout));
      set(local, next);
      writeStored(storageKey, codec.encode(next));
    },
  );
  return layout;
}

const stringSetCodec: Codec<ReadonlySet<string>> = {
  fallback: () => new Set(),
  decode: (stored) =>
    Array.isArray(stored) ? new Set(stored.filter((item): item is string => typeof item === 'string')) : undefined,
  encode: (value) => Array.from(value).sort((a, b) => a.localeCompare(b)),
};

const stringRecordCodec: Codec<Readonly<Record<string, string>>> = {
  fallback: () => ({}),
  decode: (stored) => {
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return undefined;
    return Object.fromEntries(
      Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  },
  encode: (value) =>
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))),
};

export function toggledInSet(set: ReadonlySet<string>, item: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(item)) next.delete(item);
  else next.add(item);
  return next;
}

export const dockerCollapsedHostsAtom = browserLayoutAtom(BROWSER_LAYOUT_KEYS.dockerCollapsedHosts, stringSetCodec);
export const dockerExpandedContainersAtom = browserLayoutAtom(BROWSER_LAYOUT_KEYS.dockerExpandedContainers, stringSetCodec);
export const dockerContainerShellsAtom = browserLayoutAtom(BROWSER_LAYOUT_KEYS.dockerContainerShells, stringRecordCodec);
export const stacksExpandedAtom = browserLayoutAtom(BROWSER_LAYOUT_KEYS.stacksExpandedStacks, stringSetCodec);
export const zfsExpandedHostsAtom = browserLayoutAtom(BROWSER_LAYOUT_KEYS.zfsExpandedHosts, stringSetCodec);
export const zfsExpandedPoolsAtom = browserLayoutAtom(BROWSER_LAYOUT_KEYS.zfsExpandedPools, stringSetCodec);
export const zfsExpandedVdevsAtom = browserLayoutAtom(BROWSER_LAYOUT_KEYS.zfsExpandedVdevs, stringSetCodec);
export const proxmoxCollapsedHostsAtom = browserLayoutAtom(BROWSER_LAYOUT_KEYS.proxmoxCollapsedHosts, stringSetCodec);
export const proxmoxCollapsedSectionsAtom = browserLayoutAtom(BROWSER_LAYOUT_KEYS.proxmoxCollapsedSections, stringSetCodec);
