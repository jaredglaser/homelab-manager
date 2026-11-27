import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForCondition } from '@/lib/test/wait-for-condition';

const cloud = join(import.meta.dir, '..', 'cloud');
const PIN = '1.4.4';

const BUN_IMPL = `#!/bin/bash
case "$1" in
  install)
    echo "$PWD" >>"$FAKE_STATE/installs"
    [ -n "$FAKE_INSTALL_SLEEP" ] && sleep "$FAKE_INSTALL_SLEEP"
    [ -f "$FAKE_STATE/install-fails" ] && exit 1
    mkdir -p node_modules ;;
esac
exit 0
`;

const FAKES: Record<string, string> = {
  'bun-impl': BUN_IMPL,
  bun: `#!/bin/bash
if [ "$1" = --version ]; then cat "$FAKE_STATE/bun-version" 2>/dev/null; exit; fi
exec "$FAKE_BIN/bun-impl" "$@"
`,
  npm: `#!/bin/bash
echo "$*" >>"$FAKE_STATE/npm"
[ -f "$FAKE_STATE/npm-fails" ] && exit 1
while [ $# -gt 0 ]; do
  case "$1" in --prefix) prefix="$2"; shift ;; bun@*) version="\${1#bun@}" ;; esac
  shift
done
mkdir -p "$prefix/node_modules/.bin"
printf '#!/bin/bash\\n[ "$1" = --version ] && { echo %s; exit; }\\nexec "$FAKE_BIN/bun-impl" "$@"\\n' "$version" >"$prefix/node_modules/.bin/bun"
chmod +x "$prefix/node_modules/.bin/bun"
`,
  docker: `#!/bin/bash
echo "$*" >>"$FAKE_STATE/docker"
[ "$1" = info ] && { [ -f "$FAKE_STATE/docker-up" ]; exit; }
[ "$1" = image ] && exit 1
exit 0
`,
  dockerd: `#!/bin/bash
echo "$*" >>"$FAKE_STATE/dockerd"
[ -f "$FAKE_STATE/dockerd-fails" ] || touch "$FAKE_STATE/docker-up"
`,
  pgrep: '#!/bin/bash\nexit 1\n',
  pkill: '#!/bin/bash\necho "$*" >>"$FAKE_STATE/pkill"\n',
};

let dir: string;
let repo: string;
let state: string;
let bin: string;

function write(path: string, content: string) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function markInstalled(pkg: string) {
  const hash = new Bun.CryptoHasher('sha256')
    .update(readFileSync(join(pkg, 'package.json')))
    .update(readFileSync(join(pkg, 'bun.lock')))
    .digest('hex');
  write(join(pkg, 'node_modules', '.hlm-lock-hash'), `${hash}\n`);
}

function installs(): string[] {
  const file = join(state, 'installs');
  return existsSync(file) ? readFileSync(file, 'utf-8').trim().split('\n') : [];
}

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: dir,
    CLAUDE_CODE_REMOTE: 'true',
    FAKE_STATE: state,
    FAKE_BIN: bin,
    HLM_REPO_DIR: repo,
    HLM_TOOLS_DIR: join(dir, 'tools'),
    HLM_BUN_LINKS: join(bin, 'bun'),
    HLM_DOCKERD_LOG: join(dir, 'dockerd.log'),
    HLM_DOCKER_RUN_DIR: join(dir, 'run'),
    HLM_START_LOG: join(dir, 'start.log'),
    HLM_DOCKER_WAIT_MS: '0',
    HLM_PROXY_CA: join(dir, 'ca.crt'),
    HLM_SETUP_LOG_DIR: dir,
    HLM_HEAVY_LOCK: join(dir, 'heavy', 'heavy.lock'),
    ...extra,
  };
}

function start(extra: Record<string, string> = {}) {
  const proc = Bun.spawnSync(['bash', join(cloud, 'session-start.sh')], { cwd: tmpdir(), env: env(extra) });
  return { code: proc.exitCode, stdout: proc.stdout.toString() };
}

async function heavy(args: string[], extra: Record<string, string> = {}) {
  const proc = Bun.spawn(['bash', join(cloud, 'heavy.sh'), ...args], {
    cwd: dir,
    env: env(extra),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function holdLock(seconds: string) {
  const lock = join(dir, 'heavy', 'heavy.lock');
  mkdirSync(join(dir, 'heavy'), { recursive: true });
  const proc = Bun.spawn(['flock', lock, 'bash', '-c', `touch "${lock}.taken"; sleep ${seconds}`], { cwd: dir });
  await waitForCondition(() => existsSync(`${lock}.taken`), { timeoutMs: 1000 });
  return proc;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloud-box-'));
  repo = join(dir, 'repo');
  state = join(dir, 'state');
  bin = join(dir, 'bin');
  mkdirSync(state, { recursive: true });
  mkdirSync(join(dir, 'run', 'docker', 'containerd'), { recursive: true });
  for (const [name, body] of Object.entries(FAKES)) {
    write(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  write(join(repo, '.bun-version'), `${PIN}\n`);
  for (const pkg of [repo, join(repo, 'agent')]) {
    write(join(pkg, 'package.json'), '{"name":"fixture"}\n');
    write(join(pkg, 'bun.lock'), '{"lockfileVersion":1}\n');
  }
  write(join(dir, 'ca.crt'), 'fixture ca\n');
  write(join(state, 'bun-version'), `${PIN}\n`);
  writeFileSync(join(state, 'docker-up'), '');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('session-start.sh', () => {
  test('does nothing outside a cloud box', () => {
    const { code, stdout } = start({ CLAUDE_CODE_REMOTE: '' });

    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(installs()).toEqual([]);
    expect(existsSync(join(state, 'docker'))).toBe(false);
  });

  test('prints one ready line and installs nothing when everything is current', () => {
    markInstalled(repo);
    markInstalled(join(repo, 'agent'));

    const { code, stdout } = start();

    expect(code).toBe(0);
    expect(stdout).toBe(`Box ready: Bun ${PIN}, dependencies installed, Docker running.\n`);
    expect(installs()).toEqual([]);
  });

  test('installs the app again when its lockfile changed since the last install', () => {
    markInstalled(repo);
    markInstalled(join(repo, 'agent'));
    writeFileSync(join(repo, 'bun.lock'), '{"lockfileVersion":1,"changed":true}\n');

    const { stdout } = start();

    expect(installs()).toEqual([repo]);
    expect(stdout).toBe(`Box ready: Bun ${PIN}, dependencies installed, Docker running.\n`);
  });

  test('checks and installs the agent package from its own lockfile', () => {
    markInstalled(repo);

    start();
    const second = start();

    expect(installs()).toEqual([join(repo, 'agent')]);
    expect(second.stdout).toBe(`Box ready: Bun ${PIN}, dependencies installed, Docker running.\n`);
  });

  test('stops an install that would outrun the limit and still says the box is not ready', () => {
    const begun = performance.now();
    const { stdout } = start({ HLM_START_BUDGET_MS: '300', FAKE_INSTALL_SLEEP: '5' });

    expect(performance.now() - begun).toBeLessThan(1500);
    expect(stdout).toBe(
      'Box not ready: dependencies failed to install. Run `bun run setup` and read its output before anything else.\n',
    );
  });

  test('says not ready, never nothing, when nothing can be fetched', () => {
    write(join(state, 'bun-version'), '1.3.9\n');
    writeFileSync(join(state, 'npm-fails'), '');
    writeFileSync(join(state, 'install-fails'), '');

    const offPin = start();
    write(join(state, 'bun-version'), `${PIN}\n`);
    const onPin = start();

    expect(offPin.stdout).toBe(
      `Box not ready: Bun is 1.3.9 and the pin is ${PIN}. Test failures here may come from the version, not from the change.\n`,
    );
    expect(onPin.stdout).toBe(
      'Box not ready: dependencies failed to install. Run `bun run setup` and read its output before anything else.\n',
    );
  });

  test('repairs what went missing when it runs again on resume', () => {
    start();
    rmSync(join(repo, 'node_modules'), { recursive: true });

    const { stdout } = start();

    expect(installs()).toEqual([repo, join(repo, 'agent'), repo]);
    expect(stdout).toBe(`Box ready: Bun ${PIN}, dependencies installed, Docker running.\n`);
  });

  test('puts Bun back on the pin and says what it was', () => {
    markInstalled(repo);
    markInstalled(join(repo, 'agent'));
    write(join(state, 'bun-version'), '1.3.9\n');

    const { stdout } = start();

    expect(stdout).toBe(`Box ready. Bun was 1.3.9 and is now ${PIN}, the pinned version.\n`);
    expect(lstatSync(join(bin, 'bun')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(bin, 'bun'))).toBe(join(dir, 'tools', 'bun', 'node_modules', '.bin', 'bun'));
    expect(readFileSync(join(state, 'npm'), 'utf-8')).toContain(`bun@${PIN}`);
  });

  test('starts dockerd after clearing stale pid files and reports when it does not come up', () => {
    markInstalled(repo);
    markInstalled(join(repo, 'agent'));
    rmSync(join(state, 'docker-up'));
    writeFileSync(join(state, 'dockerd-fails'), '');
    writeFileSync(join(dir, 'run', 'docker.pid'), '1');
    writeFileSync(join(dir, 'run', 'docker', 'containerd', 'containerd.pid'), '1');

    const { stdout } = start();

    expect(stdout).toBe(
      `Box partly ready: Docker did not start (see ${join(dir, 'dockerd.log')}). Checks that need the local stack cannot run.\n`,
    );
    expect(readFileSync(join(state, 'dockerd'), 'utf-8')).toContain('--registry-mirror=https://mirror.gcr.io');
    expect(existsSync(join(dir, 'run', 'docker.pid'))).toBe(false);
    expect(existsSync(join(dir, 'run', 'docker', 'containerd', 'containerd.pid'))).toBe(false);
  });

  test('the weekly setup still runs the start script and exits cleanly', () => {
    const proc = Bun.spawnSync(['bash', join(cloud, 'setup.sh')], { cwd: tmpdir(), env: env() });

    expect(proc.exitCode).toBe(0);
    expect(readFileSync(join(dir, 'hlm-setup-start.log'), 'utf-8')).toBe(
      `Box ready: Bun ${PIN}, dependencies installed, Docker running.\n`,
    );
    expect(readFileSync(join(state, 'pkill'), 'utf-8')).toBe('-x dockerd\n');
  });
});

describe('heavy.sh', () => {
  test('runs one command at a time while the others wait their turn', async () => {
    const log = join(dir, 'runs.log');
    const command = `echo "start $(date +%s%N)" >>${log}; sleep 0.15; echo "end $(date +%s%N)" >>${log}`;

    const results = await Promise.all([1, 2, 3].map(() => heavy(['bash', '-c', command])));

    const stamps = readFileSync(log, 'utf-8').trim().split('\n');
    expect(stamps.map((line) => line.split(' ')[0])).toEqual(['start', 'end', 'start', 'end', 'start', 'end']);
    expect(results.every((result) => result.code === 0)).toBe(true);
    const waited = results.filter((result) => result.stderr.startsWith('Waiting for another heavy command to finish:'));
    expect(waited.length).toBeGreaterThanOrEqual(1);
  });

  test('passes output and exit code through unchanged', async () => {
    const result = await heavy(['bash', '-c', 'echo out; echo err >&2; exit 7']);

    expect(result).toEqual({ code: 7, stdout: 'out\n', stderr: 'err\n' });
  });

  test('names the command holding the lock and how long it has run', async () => {
    const holder = await holdLock('1');
    const started = Math.floor(Date.now() / 1000) - 180;
    writeFileSync(join(dir, 'heavy', 'heavy.lock.holder'), `${holder.pid} ${started} bun run test:all\n`);

    const result = await heavy(['true'], { HLM_HEAVY_WAIT_SECONDS: '0.1' });
    holder.kill();

    expect(result.stderr.split('\n')[0]).toBe(
      'Waiting for another heavy command to finish: bun run test:all, running for 3 minutes.',
    );
  });

  test('names a holder that took the lock with plain flock', async () => {
    const holder = await holdLock('1');

    const result = await heavy(['true'], { HLM_HEAVY_WAIT_SECONDS: '0.1' });
    holder.kill();

    expect(result.stderr.split('\n')[0]).toMatch(
      /^Waiting for another heavy command to finish: bash -c .*sleep 1, running for 0 minutes\.$/,
    );
  });

  test('gives up after the wait limit without running the command', async () => {
    const holder = await holdLock('1');
    const marker = join(dir, 'ran');

    const result = await heavy(['touch', marker], { HLM_HEAVY_WAIT_SECONDS: '0.3' });
    holder.kill();

    expect(result.code).toBe(75);
    expect(result.stderr.split('\n')[1]).toBe('Gave up after waiting 0.005 minutes. Nothing was run.');
    expect(existsSync(marker)).toBe(false);
  });

  test('stops a command that overruns the run limit', async () => {
    const result = await heavy(['sleep', '5'], { HLM_HEAVY_RUN_SECONDS: '0.3' });

    expect(result.code).toBe(124);
    expect(result.stderr).toBe('Stopped after 0.005 minutes: sleep 5. It did not finish.\n');
  });
});
