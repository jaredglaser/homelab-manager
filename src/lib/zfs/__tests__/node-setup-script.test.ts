import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DISPATCH_EXIT_MISSING,
  DISPATCH_EXIT_REFUSED,
  ZFS_DISPATCH_PATH,
  ZFS_INFLUXDB_COMMAND,
  ZFS_STATUS_COMMAND,
  buildAuthorizedKeysLine,
  buildDispatcherScript,
  buildSetupScript,
  buildPathGuard,
  buildSshdDropIn,
  ZFS_SSHD_DROP_IN,
} from '../node-setup-script';

const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP3uexample';

let dir: string;
let dispatcher: string;
let missingDispatcher: string;

function fakeBinary(name: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nprintf '%s' "${name}"\nfor arg in "$@"; do printf ' [%s]' "$arg"; done\n`);
  chmodSync(path, 0o755);
  return path;
}

function run(script: string, command: string | undefined) {
  const env: Record<string, string> = { PATH: '/usr/bin:/bin' };
  if (command !== undefined) env.SSH_ORIGINAL_COMMAND = command;
  const result = Bun.spawnSync(['/bin/sh', script, '-c', script], { env });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'zfs-dispatch-'));
  const influxdb = fakeBinary('zpool_influxdb');
  const zpool = fakeBinary('zpool');
  dispatcher = join(dir, 'dispatch');
  writeFileSync(dispatcher, buildDispatcherScript({ influxdb: [join(dir, 'absent'), influxdb], zpool: [zpool] }));
  missingDispatcher = join(dir, 'dispatch-missing');
  writeFileSync(missingDispatcher, buildDispatcherScript({ influxdb: [join(dir, 'absent')], zpool: [join(dir, 'absent')] }));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('dispatcher', () => {
  test('runs zpool_influxdb with the fixed arguments, from the first path that exists', () => {
    const result = run(dispatcher, ZFS_INFLUXDB_COMMAND);
    expect(result).toEqual({ code: 0, stdout: 'zpool_influxdb [--execd] [--no-histograms]', stderr: '' });
  });

  test('runs zpool status with the fixed arguments', () => {
    const result = run(dispatcher, ZFS_STATUS_COMMAND);
    expect(result).toEqual({ code: 0, stdout: 'zpool [status] [-j] [--json-int]', stderr: '' });
  });

  test.each([
    ['no command (an interactive login)', undefined],
    ['an empty command', ''],
    ['a shell', '/bin/sh'],
    ['a pool action', 'zpool destroy tank'],
    ['an extra argument', `${ZFS_STATUS_COMMAND} -v`],
    ['a pool argument', `${ZFS_INFLUXDB_COMMAND} tank`],
    ['a chained command', `${ZFS_STATUS_COMMAND}; id`],
    ['a command after a newline', `${ZFS_STATUS_COMMAND}\nid`],
    ['a trailing newline', `${ZFS_STATUS_COMMAND}\n`],
    ['quoted arguments', `zpool status '-j' "--json-int"`],
    ['command substitution', `zpool status $(id) --json-int`],
    ['a leading space', ` ${ZFS_STATUS_COMMAND}`],
    ['a very long command', `${ZFS_STATUS_COMMAND} ${'x'.repeat(100_000)}`],
  ])('refuses %s without running anything', (_label, command) => {
    const result = run(dispatcher, command);
    expect(result.code).toBe(DISPATCH_EXIT_REFUSED);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('This key may only run the homelab-manager ZFS reads.\n');
  });

  test('exits with the missing status when zpool_influxdb is not installed', () => {
    const result = run(missingDispatcher, ZFS_INFLUXDB_COMMAND);
    expect(result).toEqual({ code: DISPATCH_EXIT_MISSING, stdout: '', stderr: 'zpool_influxdb is not installed on this node.\n' });
  });

  test('rejects a candidate path a shell would read as more than a path', () => {
    expect(() => buildDispatcherScript({ influxdb: ['/bin/zpool_influxdb; id'], zpool: ['/sbin/zpool'] })).toThrow();
  });
});

describe('authorized_keys line', () => {
  test('restricts the key to the dispatcher', () => {
    expect(buildAuthorizedKeysLine({ nodeName: 'pve1', publicKey: PUBLIC_KEY, allowedFrom: null })).toBe(
      `restrict,command="${ZFS_DISPATCH_PATH}" ${PUBLIC_KEY} homelab-manager:pve1`,
    );
  });

  test('adds from= only when the worker address is given', () => {
    expect(buildAuthorizedKeysLine({ nodeName: 'pve1', publicKey: PUBLIC_KEY, allowedFrom: '10.0.0.0/24,worker.lan' })).toBe(
      `restrict,command="${ZFS_DISPATCH_PATH}",from="10.0.0.0/24,worker.lan" ${PUBLIC_KEY} homelab-manager:pve1`,
    );
  });

  test.each([
    ['a quote in from=', { nodeName: 'pve1', publicKey: PUBLIC_KEY, allowedFrom: '10.0.0.1",command="/bin/sh' }],
    ['a space in from=', { nodeName: 'pve1', publicKey: PUBLIC_KEY, allowedFrom: '10.0.0.1 x' }],
    ['a quote in the node name', { nodeName: "pve1'", publicKey: PUBLIC_KEY, allowedFrom: null }],
    ['a public key with a comment', { nodeName: 'pve1', publicKey: `${PUBLIC_KEY} evil`, allowedFrom: null }],
  ])('refuses %s', (_label, input) => {
    expect(() => buildAuthorizedKeysLine(input)).toThrow();
  });
});

describe('setup script', () => {
  const script = buildSetupScript({ nodeName: 'pve1', publicKey: PUBLIC_KEY, allowedFrom: null });

  test('parses as a POSIX shell script', () => {
    const path = join(dir, 'setup.sh');
    writeFileSync(path, script);
    expect(Bun.spawnSync(['/bin/sh', '-n', path]).exitCode).toBe(0);
  });

  test('gives hlm no password and no login shell, and installs the key line', () => {
    expect(script).toContain(`--shell ${ZFS_DISPATCH_PATH} --password '*' hlm`);
    expect(script).toContain(buildAuthorizedKeysLine({ nodeName: 'pve1', publicKey: PUBLIC_KEY, allowedFrom: null }));
    expect(script).toContain(buildDispatcherScript());
  });

  test('refuses before changing anything on a node without an ed25519 host key or with a foreign hlm user', () => {
    const firstChange = script.indexOf('install -d');
    for (const guard of [
      "fail 'This node has no ed25519 SSH host key, which the app needs. Run ssh-keygen -A, then run this script again.'",
      "fail 'A user named hlm already exists and was not created by this script. Remove or rename it, then run this script again.'",
    ]) {
      expect(script).toContain(guard);
      expect(script.indexOf(guard)).toBeLessThan(firstChange);
    }
  });

  test('creates hlm without a group of its own, so an existing hlm group cannot stop it', () => {
    expect(script).toContain('useradd --system --no-create-home --no-user-group --gid nogroup');
  });

  test('removes a stale authorized_keys2 and pins sshd to the one key file for hlm', () => {
    expect(script).toContain('rm -f /var/lib/hlm/.ssh/authorized_keys2');
    expect(script).toContain(`cat > ${ZFS_SSHD_DROP_IN}.new <<'HLM_SSHD'\n${buildSshdDropIn()}HLM_SSHD`);
    expect(buildSshdDropIn()).toContain('AuthorizedKeysFile /var/lib/hlm/.ssh/authorized_keys');
    expect(buildSshdDropIn().trimEnd().split('\n').at(-1)).toBe('Match all');
    expect(script.indexOf('if ! sshd -t; then')).toBeGreaterThan(script.indexOf(`mv ${ZFS_SSHD_DROP_IN}.new`));
    expect(script.indexOf('if ! sshd -t; then')).toBeLessThan(script.indexOf('systemctl reload ssh'));
  });

  const sshd = Bun.which('sshd', { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' });
  const sshKeygen = Bun.which('ssh-keygen', { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' });
  test.skipIf(!sshd || !sshKeygen || !existsSync('/run/sshd'))('writes a drop-in sshd accepts, which applies to hlm only', () => {
    const hostKey = join(dir, 'host_ed25519');
    rmSync(hostKey, { force: true });
    expect(Bun.spawnSync([sshKeygen!, '-q', '-t', 'ed25519', '-N', '', '-f', hostKey]).exitCode).toBe(0);
    const config = join(dir, 'sshd_config');
    writeFileSync(config, `HostKey ${hostKey}\nUsePAM no\n${buildSshdDropIn()}PermitTTY yes\n`);
    const check = Bun.spawnSync([sshd!, '-t', '-f', config]);
    expect({ code: check.exitCode, stderr: check.stderr.toString() }).toEqual({ code: 0, stderr: '' });
    const forUser = (user: string) => Bun.spawnSync([sshd!, '-T', '-f', config, '-C', `user=${user},host=localhost,addr=127.0.0.1`]).stdout.toString();
    expect(forUser('hlm')).toContain('permittty no');
    expect(forUser('hlm')).toContain('allowtcpforwarding no');
    expect(forUser('root')).toContain('permittty yes');
  });

  test('stops on a home or .ssh that is a link or owned by another user, before anything chowns or deletes through it', () => {
    const base = mkdtempSync(join(tmpdir(), 'zfs-guard-'));
    try {
      const root = process.getuid?.() === 0;
      const linked = join(base, 'linked');
      const foreign = join(base, 'foreign');
      const missing = join(base, 'missing');
      const owned = join(base, 'owned');
      symlinkSync('/etc', linked);
      mkdirSync(foreign);
      mkdirSync(owned);
      if (root) chownSync(foreign, 65534, 65534);
      const guard = (path: string) => Bun.spawnSync(['/bin/sh', '-c', `fail() { echo "$1" >&2; exit 1; }\n${buildPathGuard([path])}echo passed`]);
      const refused = (path: string) => ({ code: 1, stdout: '', stderr: `${path} is a link or is not owned by root. Remove it, then run this script again.\n` });

      const linkedRun = guard(linked);
      expect({ code: linkedRun.exitCode, stdout: linkedRun.stdout.toString(), stderr: linkedRun.stderr.toString() }).toEqual(refused(linked));
      const foreignRun = guard(foreign);
      expect({ code: foreignRun.exitCode, stdout: foreignRun.stdout.toString(), stderr: foreignRun.stderr.toString() }).toEqual(refused(foreign));
      expect(guard(missing).stdout.toString()).toBe('passed\n');
      if (root) expect(guard(owned).stdout.toString()).toBe('passed\n');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('runs the path guard on the dispatcher directory, the home and .ssh before the first install', () => {
    const guard = buildPathGuard(['/usr/local/libexec/homelab-manager', '/var/lib/hlm', '/var/lib/hlm/.ssh']);
    expect(script).toContain(guard);
    expect(script.indexOf(guard)).toBeLessThan(script.indexOf('install -d'));
  });

  test('ends by printing the ed25519 host key fingerprint', () => {
    const lines = script.trimEnd().split('\n');
    expect(lines.at(-1)).toBe(
      `echo "Host key fingerprint: $(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}')"`,
    );
  });
});
