import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  test('ends by printing the ed25519 host key fingerprint', () => {
    const lines = script.trimEnd().split('\n');
    expect(lines.at(-1)).toBe(
      `echo "Host key fingerprint: $(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}')"`,
    );
  });
});
