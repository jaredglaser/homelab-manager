export interface ZfsCapabilities {
  available: boolean;
  version?: string;
  tier: number;
  permissions: string[];
}

const UNAVAILABLE: ZfsCapabilities = {
  available: false,
  tier: 0,
  permissions: [],
};

const SNAPSHOT_PERMISSIONS = ['snapshot', 'hold', 'send', 'rollback', 'destroy'];

/**
 * Spawn a command and return its stdout as a trimmed string.
 * Returns null if the command fails or exits with a non-zero code.
 */
async function runCommand(cmd: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(cmd, {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const output = await new Response(proc.stdout).text();
    return output.trim();
  } catch {
    return null;
  }
}

/**
 * Parse a ZFS version string from `zpool version` or `zpool --version` output.
 * Looks for patterns like "zfs-2.2.2" or "zfs-2.1.0-rc1".
 */
function parseVersion(output: string): string | undefined {
  const match = output.match(/zfs-(\d+\.\d+\.\d+(?:-rc\d+)?)/);
  return match?.[1];
}

/**
 * Parse `zfs allow` output to extract delegation permissions.
 * The output format includes lines like:
 *   user admin create,destroy,snapshot,hold,send,rollback
 *   group zfs snapshot,hold,send
 */
function parsePermissions(output: string): string[] {
  const permissions = new Set<string>();
  const lines = output.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 3) {
      const permList = parts[parts.length - 1];
      if (permList && permList.includes(',')) {
        for (const perm of permList.split(',')) {
          permissions.add(perm.trim());
        }
      } else if (permList && /^[a-z]+$/.test(permList)) {
        permissions.add(permList);
      }
    }
  }
  return [...permissions].sort();
}

/**
 * Determine the capability tier based on available permissions.
 * - Tier 0: ZFS unavailable
 * - Tier 1: Monitoring only (zpool binary exists and is executable)
 * - Tier 2: Snapshot management (delegation includes snapshot, hold, send, rollback, destroy)
 */
function determineTier(permissions: string[]): number {
  const hasAll = SNAPSHOT_PERMISSIONS.every((p) => permissions.includes(p));
  return hasAll ? 2 : 1;
}

/**
 * Detect ZFS capabilities on the host by checking for the zpool binary,
 * querying its version, and inspecting delegation permissions.
 */
export async function detectZfsCapabilities(): Promise<ZfsCapabilities> {
  const whichResult = await runCommand(['which', 'zpool']);
  if (!whichResult) return UNAVAILABLE;

  let version: string | undefined;
  const versionOutput = await runCommand(['zpool', 'version']);
  if (versionOutput) {
    version = parseVersion(versionOutput);
  }
  if (!version) {
    const altOutput = await runCommand(['zpool', '--version']);
    if (altOutput) {
      version = parseVersion(altOutput);
    }
  }

  const allowOutput = await runCommand(['zfs', 'allow']);
  const permissions = allowOutput ? parsePermissions(allowOutput) : [];
  const tier = permissions.length > 0 ? determineTier(permissions) : 1;

  return {
    available: true,
    version,
    tier,
    permissions,
  };
}
