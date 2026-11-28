export const ZFS_NODE_USER = 'hlm';
export const ZFS_NODE_HOME = '/var/lib/hlm';
export const ZFS_DISPATCH_PATH = '/usr/local/libexec/homelab-manager/zfs-read';

/** The only two commands the dispatcher runs, matched as whole strings. */
export const ZFS_INFLUXDB_COMMAND = 'zpool_influxdb --execd --no-histograms';
export const ZFS_STATUS_COMMAND = 'zpool status -j --json-int';

export const DISPATCH_EXIT_MISSING = 127;
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

/** It never echoes the command back, so a crafted command cannot write escapes to the caller's terminal. */
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

export const ZFS_SSHD_DROP_IN = '/etc/ssh/sshd_config.d/homelab-manager-hlm.conf';
const HOST_KEY = '/etc/ssh/ssh_host_ed25519_key.pub';

export function buildSshdDropIn(): string {
  return `# Installed by homelab-manager. Applies to the ${ZFS_NODE_USER} user only.
Match User ${ZFS_NODE_USER}
    AuthorizedKeysFile ${ZFS_NODE_HOME}/.ssh/authorized_keys
    ForceCommand ${ZFS_DISPATCH_PATH}
    AllowTcpForwarding no
    AllowStreamLocalForwarding no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTTY no
    PermitTunnel no
    PasswordAuthentication no
    KbdInteractiveAuthentication no
Match all
`;
}

/** `install -d -o root` would chown through a link and `rm` would delete inside it, so a link or a path another user owns stops the script. */
export function buildPathGuard(paths: readonly string[]): string {
  return `for path in ${pathList(paths)}; do
  if [ -L "$path" ] || { [ -e "$path" ] && [ "$(stat -c %u "$path")" != 0 ]; }; then
    fail "$path is a link or is not owned by root. Remove it, then run this script again."
  fi
done
`;
}

/** Running it again replaces everything it installs, which is how a node whose key was refused is repaired. */
export function buildSetupScript(input: SetupScriptInput): string {
  const keyLine = buildAuthorizedKeysLine(input);
  const dispatcher = buildDispatcherScript(input.paths);
  const dispatchDir = ZFS_DISPATCH_PATH.slice(0, ZFS_DISPATCH_PATH.lastIndexOf('/'));
  const influxdbPaths = pathList((input.paths ?? DEFAULT_DISPATCHER_PATHS).influxdb);
  const user = ZFS_NODE_USER;
  return `#!/bin/sh
# homelab-manager: read-only ZFS access for ${input.nodeName}. Run as root.
set -eu
fail() {
  echo "$1" >&2
  exit 1
}
[ "$(id -u)" -eq 0 ] || fail 'Run this script as root.'
[ -f ${HOST_KEY} ] || fail 'This node has no ed25519 SSH host key, which the app needs. Run ssh-keygen -A, then run this script again.'
if getent passwd ${user} >/dev/null; then
  [ "$(getent passwd ${user} | cut -d: -f7)" = ${ZFS_DISPATCH_PATH} ] || fail 'A user named ${user} already exists and was not created by this script. Remove or rename it, then run this script again.'
fi
${buildPathGuard([dispatchDir, ZFS_NODE_HOME, `${ZFS_NODE_HOME}/.ssh`])}
install -d -o root -g root -m 0755 ${dispatchDir}
rm -f ${ZFS_DISPATCH_PATH}.new
cat > ${ZFS_DISPATCH_PATH}.new <<'HLM_DISPATCH'
${dispatcher}HLM_DISPATCH
chown root:root ${ZFS_DISPATCH_PATH}.new
chmod 0755 ${ZFS_DISPATCH_PATH}.new
mv ${ZFS_DISPATCH_PATH}.new ${ZFS_DISPATCH_PATH}

# The primary group is nogroup, so an existing group named ${user} neither stops useradd nor gains the user.
if ! getent passwd ${user} >/dev/null; then
  useradd --system --no-create-home --no-user-group --gid nogroup --home-dir ${ZFS_NODE_HOME} --shell ${ZFS_DISPATCH_PATH} ${user}
fi
# '*' matches no password but, unlike '!', does not lock the account, which sshd would refuse.
usermod --home ${ZFS_NODE_HOME} --shell ${ZFS_DISPATCH_PATH} --password '*' ${user}

install -d -o root -g root -m 0755 ${ZFS_NODE_HOME} ${ZFS_NODE_HOME}/.ssh
rm -f ${ZFS_NODE_HOME}/.ssh/authorized_keys2 ${ZFS_NODE_HOME}/.ssh/authorized_keys.new
printf '%s\\n' '${keyLine}' > ${ZFS_NODE_HOME}/.ssh/authorized_keys.new
chown root:root ${ZFS_NODE_HOME}/.ssh/authorized_keys.new
chmod 0644 ${ZFS_NODE_HOME}/.ssh/authorized_keys.new
mv ${ZFS_NODE_HOME}/.ssh/authorized_keys.new ${ZFS_NODE_HOME}/.ssh/authorized_keys

install -d -m 0755 /etc/ssh/sshd_config.d
rm -f ${ZFS_SSHD_DROP_IN}.new
cat > ${ZFS_SSHD_DROP_IN}.new <<'HLM_SSHD'
${buildSshdDropIn()}HLM_SSHD
chmod 0644 ${ZFS_SSHD_DROP_IN}.new
mv ${ZFS_SSHD_DROP_IN}.new ${ZFS_SSHD_DROP_IN}
if ! sshd -t; then
  rm -f ${ZFS_SSHD_DROP_IN}
  fail 'sshd refused the hlm settings, so they were removed. The key line still limits the key to the two reads.'
fi
if ! sshd -T -C user=${user},host=localhost,addr=127.0.0.1 | grep -qx 'permittty no'; then
  echo 'sshd does not read /etc/ssh/sshd_config.d, so the hlm settings do not apply. The key line still limits the key to the two reads.' >&2
fi
if command -v systemctl >/dev/null && systemctl is-active --quiet ssh 2>/dev/null; then
  systemctl reload ssh
elif command -v systemctl >/dev/null && systemctl is-active --quiet sshd 2>/dev/null; then
  systemctl reload sshd
else
  echo 'Reload sshd to apply the hlm settings.' >&2
fi

found=no
for bin in ${influxdbPaths}; do
  if [ -x "$bin" ]; then found=yes; fi
done
if [ "$found" = no ]; then
  echo 'zpool_influxdb was not found. Update the zfsutils-linux package on this node.' >&2
fi

echo "Host key fingerprint: $(ssh-keygen -lf ${HOST_KEY} | awk '{print $2}')"
`;
}
