/** The user the setup script creates on each ZFS node. */
export const ZFS_NODE_USER = 'hlm';
export const ZFS_NODE_HOME = '/var/lib/hlm';
export const ZFS_DISPATCH_PATH = '/usr/local/libexec/homelab-manager/zfs-read';

/** The only two commands the dispatcher runs, matched as whole strings. */
export const ZFS_INFLUXDB_COMMAND = 'zpool_influxdb --execd --no-histograms';
export const ZFS_STATUS_COMMAND = 'zpool status -j --json-int';

/** Exit status of the dispatcher when the binary behind an allowed command is not installed. */
export const DISPATCH_EXIT_MISSING = 127;
/** Exit status of the dispatcher for any command it does not allow. */
export const DISPATCH_EXIT_REFUSED = 126;

export interface DispatcherPaths {
  /** Proxmox links it into /bin. Upstream packages install it under /usr/lib/zfs-linux. */
  influxdb: readonly string[];
  zpool: readonly string[];
}

export const DEFAULT_DISPATCHER_PATHS: DispatcherPaths = {
  influxdb: ['/bin/zpool_influxdb', '/usr/lib/zfs-linux/zpool_influxdb'],
  zpool: ['/usr/sbin/zpool', '/sbin/zpool'],
};

const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;

function pathList(paths: readonly string[]): string {
  for (const path of paths) {
    if (!SAFE_PATH.test(path)) throw new Error(`Unsafe dispatcher path: ${path}`);
  }
  return paths.join(' ');
}

/**
 * The script sshd runs for every login with the app's key, both as the forced command and as the
 * user's shell. It reads SSH_ORIGINAL_COMMAND, runs one of the two allowed reads with fixed
 * arguments, and refuses everything else. It never echoes the command back.
 */
export function buildDispatcherScript(paths: DispatcherPaths = DEFAULT_DISPATCHER_PATHS): string {
  return `#!/bin/sh
# Installed by homelab-manager. Runs two read-only ZFS commands for the ${ZFS_NODE_USER} user and refuses the rest.
case "\${SSH_ORIGINAL_COMMAND-}" in
  '${ZFS_INFLUXDB_COMMAND}')
    for bin in ${pathList(paths.influxdb)}; do
      if [ -x "$bin" ]; then exec "$bin" --execd --no-histograms; fi
    done
    echo 'zpool_influxdb is not installed on this node.' >&2
    exit ${DISPATCH_EXIT_MISSING}
    ;;
  '${ZFS_STATUS_COMMAND}')
    for bin in ${pathList(paths.zpool)}; do
      if [ -x "$bin" ]; then exec "$bin" status -j --json-int; fi
    done
    echo 'zpool is not installed on this node.' >&2
    exit ${DISPATCH_EXIT_MISSING}
    ;;
  *)
    echo 'This key may only run the homelab-manager ZFS reads.' >&2
    exit ${DISPATCH_EXIT_REFUSED}
    ;;
esac
`;
}

/** An address list for the `from=` key option: hosts, IPs, CIDRs and wildcards, comma separated, no quotes. */
const ALLOWED_FROM = /^[A-Za-z0-9.:/*?!,_-]{1,255}$/;
const PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/;
const NODE_NAME = /^[A-Za-z0-9_-]{1,100}$/;

export function isValidAllowedFrom(value: string): boolean {
  return ALLOWED_FROM.test(value);
}

export interface SetupScriptInput {
  nodeName: string;
  /** `ssh-ed25519 <base64>` without a comment. */
  publicKey: string;
  /** The worker's address, written as `from=` when given. */
  allowedFrom: string | null;
  paths?: DispatcherPaths;
}

export function buildAuthorizedKeysLine({ nodeName, publicKey, allowedFrom }: SetupScriptInput): string {
  if (!NODE_NAME.test(nodeName)) throw new Error('Unsafe node name for authorized_keys');
  if (!PUBLIC_KEY.test(publicKey)) throw new Error('Unexpected public key format');
  if (allowedFrom !== null && !isValidAllowedFrom(allowedFrom)) throw new Error('Unsafe from= value');
  const options = ['restrict', `command="${ZFS_DISPATCH_PATH}"`];
  if (allowedFrom !== null) options.push(`from="${allowedFrom}"`);
  return `${options.join(',')} ${publicKey} homelab-manager:${nodeName}`;
}

/**
 * The script the user pastes on the node as root. Running it again replaces the dispatcher and the
 * key line, so it also repairs a node whose key was refused. The home directory, `.ssh` and
 * `authorized_keys` are owned by root, so the hlm user cannot change which key it accepts.
 */
export function buildSetupScript(input: SetupScriptInput): string {
  const keyLine = buildAuthorizedKeysLine(input);
  const dispatcher = buildDispatcherScript(input.paths);
  const dispatchDir = ZFS_DISPATCH_PATH.slice(0, ZFS_DISPATCH_PATH.lastIndexOf('/'));
  const influxdbPaths = pathList((input.paths ?? DEFAULT_DISPATCHER_PATHS).influxdb);
  return `#!/bin/sh
# homelab-manager: read-only ZFS access for ${input.nodeName}. Run as root.
set -eu
if [ "$(id -u)" -ne 0 ]; then
  echo 'Run this script as root.' >&2
  exit 1
fi

install -d -o root -g root -m 0755 ${dispatchDir}
cat > ${ZFS_DISPATCH_PATH}.new <<'HLM_DISPATCH'
${dispatcher}HLM_DISPATCH
chown root:root ${ZFS_DISPATCH_PATH}.new
chmod 0755 ${ZFS_DISPATCH_PATH}.new
mv ${ZFS_DISPATCH_PATH}.new ${ZFS_DISPATCH_PATH}

if ! id ${ZFS_NODE_USER} >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir ${ZFS_NODE_HOME} --shell ${ZFS_DISPATCH_PATH} ${ZFS_NODE_USER}
fi
# '*' matches no password but, unlike '!', does not lock the account, which sshd would refuse.
usermod --home ${ZFS_NODE_HOME} --shell ${ZFS_DISPATCH_PATH} --password '*' ${ZFS_NODE_USER}

install -d -o root -g root -m 0755 ${ZFS_NODE_HOME} ${ZFS_NODE_HOME}/.ssh
printf '%s\\n' '${keyLine}' > ${ZFS_NODE_HOME}/.ssh/authorized_keys.new
chown root:root ${ZFS_NODE_HOME}/.ssh/authorized_keys.new
chmod 0644 ${ZFS_NODE_HOME}/.ssh/authorized_keys.new
mv ${ZFS_NODE_HOME}/.ssh/authorized_keys.new ${ZFS_NODE_HOME}/.ssh/authorized_keys

found=no
for bin in ${influxdbPaths}; do
  if [ -x "$bin" ]; then found=yes; fi
done
if [ "$found" = no ]; then
  echo 'zpool_influxdb was not found. Update the zfsutils-linux package on this node.' >&2
fi

echo "Host key fingerprint: $(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}')"
`;
}
