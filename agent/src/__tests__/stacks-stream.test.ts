import { afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  handleStackDeploy,
  handleStackRestart,
  handleStackStart,
  handleStackStop,
  handleStackTeardown,
  handleStackUpdate,
  wantsEventStream,
} from '../routes/stacks';
import { ComposeRunRegistry } from '../lib/compose-run';
import { agentRouteFailureMessage } from '../lib/error-body';
import { AGENT_ROUTE_FAILURE_CODES, isAgentRouteFailureCode, type AgentRouteFailureCode } from '../types';
import { zComposeFrames } from '../types/protocol';
import { ControlledProcess, finishedProcess, unreadableProcess } from '../lib/test/fake-process';
import { bounded, parseEventFrames, readUntil } from '../lib/test/sse-test-utils';

beforeAll(() => {
  console.error = mock(() => undefined);
});

const DIR = join(import.meta.dir, '../../.test-stacks-stream');
const COMPOSE = 'services:\n  app:\n    image: nginx';

type Route = 'deploy' | 'update' | 'teardown' | 'restart' | 'start' | 'stop';
const ROUTES: Route[] = ['deploy', 'update', 'teardown', 'restart', 'start', 'stop'];
const PHASE_OF: Record<Route, string> = {
  deploy: 'up',
  update: 'pull',
  teardown: 'down',
  restart: 'restart',
  start: 'start',
  stop: 'stop',
};

type Spawn = (opts: { cmd: string[] }) => unknown;
type SpawnArg = Parameters<typeof handleStackDeploy>[2];

function call(route: Route, request: Request, spawn: Spawn, registry = new ComposeRunRegistry(), timeoutMs?: number) {
  const s = spawn as unknown as SpawnArg;
  switch (route) {
    case 'deploy': return handleStackDeploy(request, DIR, s, timeoutMs, registry);
    case 'update': return handleStackUpdate(request, DIR, s, timeoutMs, timeoutMs, registry);
    case 'teardown': return handleStackTeardown(request, DIR, s, timeoutMs, registry);
    case 'restart': return handleStackRestart(request, DIR, s, timeoutMs, registry);
    case 'start': return handleStackStart(request, DIR, s, timeoutMs, registry);
    case 'stop': return handleStackStop(request, DIR, s, timeoutMs, registry);
  }
}

function validBody(route: Route): Record<string, unknown> {
  if (route === 'deploy' || route === 'update') return { stack: 'app', composeContent: COMPOSE };
  if (route === 'teardown') return { stack: 'app' };
  return { stack: 'app', scope: 'stack' };
}

function post(route: Route, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return new Request(`http://localhost/stacks/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal,
  });
}

const STREAM = { Accept: 'text/event-stream' };
type ConsoleSpy = ReturnType<typeof spyOn<typeof console, 'error' | 'info'>>;

beforeEach(() => {
  mkdirSync(join(DIR, 'app'), { recursive: true });
  writeFileSync(join(DIR, 'app', 'docker-compose.yml'), COMPOSE);
});

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
});

describe('wantsEventStream', () => {
  const accept = (value?: string) => wantsEventStream(new Request('http://x/', value === undefined ? {} : { headers: { Accept: value } }));

  test('is true when the header lists text/event-stream, in any position, case or parameter form', () => {
    expect(accept('text/event-stream')).toBe(true);
    expect(accept('text/event-stream, application/json')).toBe(true);
    expect(accept('application/json, text/event-stream;q=0.5')).toBe(true);
    expect(accept('Text/Event-Stream')).toBe(true);
  });

  test('is false for no header, wildcards, other types and q=0', () => {
    expect(accept()).toBe(false);
    expect(accept('*/*')).toBe(false);
    expect(accept('text/*')).toBe(false);
    expect(accept('application/json')).toBe(false);
    expect(accept('text/event-stream;q=0')).toBe(false);
    expect(accept('text/event-streams')).toBe(false);
  });
});

describe('JSON mode is unchanged', () => {
  const acceptVariants: Record<string, Record<string, string>> = {
    'no Accept header': {},
    'application/json': { Accept: 'application/json' },
    '*/*': { Accept: '*/*' },
    'text/*': { Accept: 'text/*' },
    'text/html': { Accept: 'text/html' },
  };

  for (const route of ROUTES) {
    describe(route, () => {
      for (const [name, headers] of Object.entries(acceptVariants)) {
        test(`success body is byte-identical with ${name}`, async () => {
          const registry = new ComposeRunRegistry();
          const spawn = () => finishedProcess({ stdout: ['out\n'], stderr: ['err\n'] });
          const response = await call(route, post(route, validBody(route), headers), spawn, registry);

          expect(response.status).toBe(200);
          expect(response.headers.get('content-type')).toStartWith('application/json');
          expect(await response.text()).toBe(
            route === 'update'
              ? '{"status":"success","stdout":"out\\nout\\n","stderr":"err\\nerr\\n"}'
              : '{"status":"success","stdout":"out\\n","stderr":"err\\n"}',
          );
          expect(registry.size).toBe(0);
        });
      }

      test('failure body is byte-identical', async () => {
        const spawn = () => finishedProcess({ stdout: ['so far\n'], stderr: ['boom\n'], exitCode: 2 });
        const response = await call(route, post(route, validBody(route)), spawn);
        expect(response.status).toBe(500);
        expect(await response.text()).toBe('{"status":"failed","exitCode":2,"stderr":"boom\\n","stdout":"so far\\n"}');
      });

      test('timeout body is byte-identical', async () => {
        const spawn = () => {
          const proc = new ControlledProcess();
          proc.write('stdout', 'partial out\n');
          proc.write('stderr', 'partial err');
          return proc;
        };
        const response = await call(route, post(route, validBody(route)), spawn, new ComposeRunRegistry(), 5);
        expect(response.status).toBe(500);
        expect(await response.text()).toBe(
          '{"status":"failed","exitCode":137,"stderr":"Process timed out after 0.005s. partial err","stdout":"partial out\\n"}',
        );
      });

      test('spawn failure body is byte-identical', async () => {
        const spawn = () => { throw new Error('docker: not found'); };
        const response = await call(route, post(route, validBody(route)), spawn);
        expect(response.status).toBe(500);
        expect(await response.text()).toBe(
          '{"error":"Failed to execute docker compose: docker: not found","code":"compose_spawn_failed"}',
        );
      });
    });
  }

  test('update still stops after a failed pull and reports only the pull output', async () => {
    const cmds: string[][] = [];
    const spawn = (opts: { cmd: string[] }) => {
      cmds.push(opts.cmd);
      return finishedProcess({ stdout: ['pull out\n'], stderr: ['pull err\n'], exitCode: 1 });
    };
    const response = await call('update', post('update', validBody('update')), spawn);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"status":"failed","exitCode":1,"stderr":"pull err\\n","stdout":"pull out\\n"}');
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain('pull');
  });

  for (const [exitCode, exitsOn] of [[0, 'spawn'], [143, 'kill']] as const) {
    const readFailure = '{"error":"Failed to execute docker compose: Reading stdout failed: pipe broke","code":"compose_spawn_failed"}';

    test(`update answers a pull whose pipe read failed (exit ${exitCode}) as a 500 and runs no up`, async () => {
      const cmds: string[][] = [];
      const spawn = (opts: { cmd: string[] }) => {
        cmds.push(opts.cmd);
        return unreadableProcess(exitCode, exitsOn);
      };
      const response = await call('update', post('update', validBody('update')), spawn);
      expect(response.status).toBe(500);
      expect(await response.text()).toBe(readFailure);
      expect(cmds).toHaveLength(1);
    });

    test(`update answers an up whose pipe read failed (exit ${exitCode}) as a 500`, async () => {
      let n = 0;
      const spawn = () => (n++ === 0 ? finishedProcess() : unreadableProcess(exitCode, exitsOn));
      const response = await call('update', post('update', validBody('update')), spawn);
      expect(response.status).toBe(500);
      expect(await response.text()).toBe(readFailure);
    });
  }

  test('update answers a pull that exits 0 after the deadline as a timeout and runs no up', async () => {
    const cmds: string[][] = [];
    const spawn = (opts: { cmd: string[] }) => {
      cmds.push(opts.cmd);
      const proc = new ControlledProcess();
      proc.kill = () => { proc.killed++; proc.exit(0); };
      return proc;
    };
    const response = await call('update', post('update', validBody('update')), spawn, new ComposeRunRegistry(), 5);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ status: 'failed', exitCode: 0, stderr: 'Process timed out after 0.005s.', stdout: '' });
    expect(cmds).toHaveLength(1);
  });

  test('update joins pull and up output when up fails', async () => {
    let n = 0;
    const spawn = () => (n++ === 0
      ? finishedProcess({ stdout: ['pulled\n'], stderr: ['p-warn\n'] })
      : finishedProcess({ stdout: ['up out\n'], stderr: ['up err\n'], exitCode: 4 }));
    const response = await call('update', post('update', validBody('update')), spawn);
    expect(await response.text()).toBe(
      '{"status":"failed","exitCode":4,"stderr":"p-warn\\nup err\\n","stdout":"pulled\\nup out\\n"}',
    );
  });

  const errorCases: { name: string; routes: Route[]; body: unknown; status: number; code: AgentRouteFailureCode; ctx?: { stack?: string }; prefix?: string }[] = [
    { name: 'invalid JSON', routes: ROUTES, body: 'not json', status: 400, code: 'invalid_json', prefix: 'Invalid JSON: ' },
    { name: 'non-object body', routes: ['deploy', 'update', 'restart', 'start', 'stop'], body: [1], status: 400, code: 'invalid_request_body' },
    { name: 'missing deploy fields', routes: ['deploy', 'update'], body: { stack: 'app' }, status: 400, code: 'missing_deploy_fields' },
    { name: 'wrong field types', routes: ['deploy', 'update'], body: { stack: 1, composeContent: COMPOSE }, status: 400, code: 'invalid_deploy_fields' },
    { name: 'wrong envContent type', routes: ['deploy', 'update'], body: { stack: 'app', composeContent: COMPOSE, envContent: 5 }, status: 400, code: 'invalid_env_content' },
    { name: 'wrong forceRecreate type', routes: ['deploy', 'update'], body: { stack: 'app', composeContent: COMPOSE, forceRecreate: 'yes' }, status: 400, code: 'invalid_force_recreate' },
    { name: 'oversized compose', routes: ['deploy', 'update'], body: { stack: 'app', composeContent: 'x'.repeat(1_048_577) }, status: 413, code: 'compose_too_large' },
    { name: 'oversized env', routes: ['deploy', 'update'], body: { stack: 'app', composeContent: COMPOSE, envContent: 'x'.repeat(65_537) }, status: 413, code: 'env_too_large' },
    { name: 'missing stack', routes: ['teardown', 'restart', 'start', 'stop'], body: { scope: 'stack' }, status: 400, code: 'missing_stack_field' },
    { name: 'invalid stack name', routes: ROUTES, body: { stack: '../etc', composeContent: COMPOSE, scope: 'stack' }, status: 400, code: 'invalid_stack_name' },
    { name: 'unknown stack', routes: ['teardown', 'restart', 'start', 'stop'], body: { stack: 'nope', scope: 'stack' }, status: 404, code: 'stack_not_found', ctx: { stack: 'nope' } },
    { name: 'service scope without a service', routes: ['restart', 'start', 'stop'], body: { stack: 'app', scope: 'service' }, status: 400, code: 'missing_service_field' },
    { name: 'invalid service name', routes: ['restart', 'start', 'stop'], body: { stack: 'app', scope: 'service', service: 'a b' }, status: 400, code: 'invalid_service_name' },
    { name: 'invalid scope', routes: ['restart', 'start', 'stop'], body: { stack: 'app', scope: 'everything' }, status: 400, code: 'invalid_scope' },
  ];

  for (const c of errorCases) {
    for (const route of c.routes) {
      for (const [label, headers] of [['no Accept header', {}], ['text/event-stream', STREAM]] as const) {
        test(`${route} answers ${c.name} with JSON ${c.status} ${c.code} (${label})`, async () => {
          const spawn = mock(() => finishedProcess());
          const registry = new ComposeRunRegistry();
          const response = await call(route, post(route, c.body, headers), spawn, registry);

          expect(response.status).toBe(c.status);
          expect(response.headers.get('content-type')).toStartWith('application/json');
          const text = await response.text();
          const body = JSON.parse(text) as { error: string; code: string };
          expect(Object.keys(body)).toEqual(['error', 'code']);
          expect(body.code).toBe(c.code);
          if (c.prefix) expect(body.error).toStartWith(c.prefix);
          else expect(body.error).toBe(agentRouteFailureMessage(c.code, c.ctx));
          expect(spawn).not.toHaveBeenCalled();
          expect(registry.size).toBe(0);
        });
      }
    }
  }

  for (const route of ['deploy', 'update'] as const) {
    test(`${route} answers a stack write failure with JSON 500 even when a stream was asked for`, async () => {
      rmSync(DIR, { recursive: true, force: true });
      writeFileSync(DIR, 'a file where the stacks directory should be');
      try {
        const spawn = mock(() => finishedProcess());
        const registry = new ComposeRunRegistry();
        const response = await call(route, post(route, validBody(route), STREAM), spawn, registry);
        expect(response.status).toBe(500);
        expect(response.headers.get('content-type')).toStartWith('application/json');
        expect((await response.json() as { code: string }).code).toBe('stack_write_failed');
        expect(spawn).not.toHaveBeenCalled();
        expect(registry.size).toBe(0);
      } finally {
        rmSync(DIR, { force: true });
      }
    });
  }
});

describe('SSE mode', () => {
  async function stream(route: Route, spawn: Spawn, opts: { registry?: ComposeRunRegistry; timeoutMs?: number; body?: unknown } = {}) {
    const response = await call(route, post(route, opts.body ?? validBody(route), STREAM), spawn, opts.registry, opts.timeoutMs);
    const frames = parseEventFrames(await bounded(response.text(), 'the event stream'));
    for (const frame of frames) {
      const schema: { parse(data: unknown): unknown } = zComposeFrames[frame.event as keyof typeof zComposeFrames];
      expect(schema.parse(frame.data)).toEqual(frame.data);
    }
    return { response, frames };
  }

  test('answers with an event stream, not JSON', async () => {
    const { response } = await stream('deploy', () => finishedProcess());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
  });

  test('deploy sends start, phase, line and result frames in that order', async () => {
    const { frames } = await stream('deploy', () => finishedProcess({ stdout: ['Container app Started\n'] }));
    expect(frames).toEqual([
      { event: 'start', data: { v: 1, runId: expect.any(String), action: 'deploy', stack: 'app' } },
      { event: 'phase', data: { seq: 1, phase: 'up', timeoutMs: 300_000 } },
      { event: 'line', data: { seq: 2, stream: 'stdout', text: 'Container app Started' } },
      {
        event: 'result',
        data: { seq: 3, status: 'success', exitCode: 0, timedOut: false, droppedLines: 0, droppedBytes: 0 },
      },
    ]);
  });

  for (const route of ROUTES) {
    test(`${route} streams under its own action and phase, with parseable frames and one final result`, async () => {
      const { frames } = await stream(route, () => finishedProcess({ stdout: ['a\nb\n'], stderr: ['w\n'] }));

      expect(frames[0].event).toBe('start');
      expect(frames[0].data).toMatchObject({ v: 1, action: route, stack: 'app' });
      expect(frames[1]).toMatchObject({ event: 'phase', data: { phase: PHASE_OF[route] } });
      expect(frames.filter((f) => f.event === 'result')).toHaveLength(1);
      expect(frames.at(-1)?.event).toBe('result');
      expect(frames.at(-1)?.data).toMatchObject({ status: 'success', exitCode: 0, timedOut: false });

      for (const frame of frames) {
        expect(zComposeFrames[frame.event as keyof typeof zComposeFrames].safeParse(frame.data).success).toBe(true);
      }
      const seqs = frames.slice(1).map((f) => f.data.seq);
      expect(seqs).toEqual(seqs.map((_, i) => i + 1));
      const perProcess = ['stderr:w', 'stdout:a', 'stdout:b'];
      const expected = route === 'update' ? [...perProcess, ...perProcess].sort() : perProcess;
      expect(frames.filter((f) => f.event === 'line').map((f) => `${String(f.data.stream)}:${String(f.data.text)}`).sort()).toEqual(expected);
    });
  }

  test('a quiet run keeps the stream warm with a heartbeat every 5 seconds', async () => {
    const real = globalThis.setInterval;
    const delays: (number | undefined)[] = [];
    const timers = spyOn(globalThis, 'setInterval').mockImplementation(
      ((fn: () => void, delay?: number) => {
        delays.push(delay);
        return real(fn, delay === 5000 ? 5 : delay);
      }) as unknown as typeof setInterval,
    );
    const proc = new ControlledProcess();
    try {
      const response = await call('deploy', post('deploy', validBody('deploy'), STREAM), () => proc);
      const seen = await readUntil(response, (text) => text.includes('\n:\n\n'));
      expect(seen).toContain('event: phase');
      expect(seen).not.toContain('event: result');
    } finally {
      timers.mockRestore();
      proc.exit(0);
    }
    expect(delays).toContain(5000);
  });

  test('control routes pass the service name to compose', async () => {
    const cmds: string[][] = [];
    const spawn = (opts: { cmd: string[] }) => { cmds.push(opts.cmd); return finishedProcess(); };
    await stream('restart', spawn, { body: { stack: 'app', scope: 'service', service: 'web' } });
    expect(cmds[0].at(-1)).toBe('web');
  });

  test('a non-zero exit is a failed result naming the phase', async () => {
    const { frames } = await stream('restart', () => finishedProcess({ stderr: ['no such service\n'], exitCode: 1 }));
    expect(frames.at(-1)?.data).toEqual({
      seq: 3,
      status: 'failed',
      exitCode: 1,
      timedOut: false,
      failedPhase: 'restart',
      droppedLines: 0,
      droppedBytes: 0,
    });
  });

  test('a timeout is a failed result with timedOut and the budget', async () => {
    const { frames } = await stream('deploy', () => new ControlledProcess(), { timeoutMs: 5 });
    expect(frames.at(-1)?.data).toMatchObject({
      status: 'failed',
      exitCode: 137,
      timedOut: true,
      timeoutMs: 5,
      failedPhase: 'up',
    });
  });

  test('a spawn failure after the stream opened is a failed result with no exit code', async () => {
    const { response, frames } = await stream('deploy', () => { throw new Error('docker: not found'); });
    expect(response.status).toBe(200);
    expect(frames.map((f) => f.event)).toEqual(['start', 'phase', 'result']);
    expect(frames.at(-1)?.data).toEqual({
      seq: 2,
      status: 'failed',
      exitCode: null,
      timedOut: false,
      failedPhase: 'up',
      code: 'compose_spawn_failed',
      detail: 'docker: not found',
      droppedLines: 0,
      droppedBytes: 0,
    });
    expect(AGENT_ROUTE_FAILURE_CODES).toContain('compose_spawn_failed');
    expect(isAgentRouteFailureCode('compose_spawn_failed')).toBe(true);
  });

  describe('update', () => {
    test('streams pull then up', async () => {
      const cmds: string[][] = [];
      const spawn = (opts: { cmd: string[] }) => {
        cmds.push(opts.cmd);
        return finishedProcess({ stdout: [opts.cmd.includes('pull') ? 'pulled\n' : 'started\n'] });
      };
      const { frames } = await stream('update', spawn);
      expect(frames.slice(1).map((f) => `${f.event}:${String(f.data.phase ?? f.data.text ?? f.data.status)}`)).toEqual([
        'phase:pull',
        'line:pulled',
        'phase:up',
        'line:started',
        'result:success',
      ]);
      expect(frames.slice(1).map((f) => f.data.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(cmds).toHaveLength(2);
    });

    test('stops after a failed pull and names the pull phase', async () => {
      const cmds: string[][] = [];
      const spawn = (opts: { cmd: string[] }) => {
        cmds.push(opts.cmd);
        return finishedProcess({ stderr: ['pull access denied\n'], exitCode: 1 });
      };
      const { frames } = await stream('update', spawn);

      expect(cmds).toHaveLength(1);
      expect(frames.filter((f) => f.event === 'phase').map((f) => f.data.phase)).toEqual(['pull']);
      expect(frames.at(-1)?.data).toMatchObject({ status: 'failed', exitCode: 1, failedPhase: 'pull' });
    });

    test('a pull timeout stops before up and reports the pull budget', async () => {
      const spawn = mock(() => new ControlledProcess());
      const { frames } = await stream('update', spawn, { timeoutMs: 5 });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(frames.at(-1)?.data).toMatchObject({ status: 'failed', timedOut: true, timeoutMs: 5, failedPhase: 'pull' });
    });

    function termTrappingPull() {
      const proc = new ControlledProcess();
      proc.kill = () => { proc.killed++; proc.exit(0); };
      return proc;
    }

    test('a pull that exits 0 after the deadline still stops before up, timed out, naming the pull phase', async () => {
      const cmds: string[][] = [];
      const spawn = (opts: { cmd: string[] }) => {
        cmds.push(opts.cmd);
        return termTrappingPull();
      };
      const { frames } = await stream('update', spawn, { timeoutMs: 5 });

      expect(cmds).toHaveLength(1);
      expect(frames.filter((f) => f.event === 'phase').map((f) => f.data.phase)).toEqual(['pull']);
      expect(frames.at(-1)?.data).toMatchObject({ status: 'failed', exitCode: 0, timedOut: true, timeoutMs: 5, failedPhase: 'pull' });
    });

    test('a failing up after a good pull names the up phase', async () => {
      let n = 0;
      const spawn = () => (n++ === 0 ? finishedProcess() : finishedProcess({ exitCode: 3 }));
      const { frames } = await stream('update', spawn);
      expect(frames.at(-1)?.data).toMatchObject({ status: 'failed', exitCode: 3, failedPhase: 'up' });
    });

    const READ_FAILURES = [
      { exitCode: 0, exitsOn: 'spawn' as const },
      { exitCode: 143, exitsOn: 'kill' as const },
    ];
    const PIPE_DETAIL = 'Reading stdout failed: pipe broke';

    for (const { exitCode, exitsOn } of READ_FAILURES) {
      test(`a pull whose pipe read failed (exit ${exitCode}) stops before up and names the pull phase`, async () => {
        const cmds: string[][] = [];
        const spawn = (opts: { cmd: string[] }) => {
          cmds.push(opts.cmd);
          return unreadableProcess(exitCode, exitsOn);
        };
        const { frames } = await stream('update', spawn);

        expect(cmds).toHaveLength(1);
        expect(frames.filter((f) => f.event === 'phase').map((f) => f.data.phase)).toEqual(['pull']);
        expect(frames.at(-1)?.data).toMatchObject({ status: 'failed', exitCode, timedOut: false, failedPhase: 'pull', detail: PIPE_DETAIL });
      });

      test(`an up whose pipe read failed (exit ${exitCode}) fails the run with the read error`, async () => {
        let n = 0;
        const spawn = () => (n++ === 0 ? finishedProcess() : unreadableProcess(exitCode, exitsOn));
        const { frames } = await stream('update', spawn);

        expect(frames.at(-1)?.data).toMatchObject({ status: 'failed', exitCode, timedOut: false, failedPhase: 'up', detail: PIPE_DETAIL });
      });
    }

    test('a spawn failure on up after a good pull names the up phase', async () => {
      let n = 0;
      const spawn = () => {
        if (n++ === 0) return finishedProcess();
        throw new Error('fork failed');
      };
      const { frames } = await stream('update', spawn);
      expect(frames.at(-1)?.data).toMatchObject({ exitCode: null, failedPhase: 'up', code: 'compose_spawn_failed', detail: 'fork failed' });
    });
  });

  describe('force recreate', () => {
    test('announces a prepare phase and keeps compose config and rm output out of the stream', async () => {
      const cmds: string[][] = [];
      const spawn = (opts: { cmd: string[] }) => {
        cmds.push(opts.cmd);
        if (opts.cmd.includes('config')) return finishedProcess({ stdout: ['services:\n  web:\n    container_name: web-1\n    environment:\n      TOKEN: hunter2\n'] });
        if (opts.cmd.includes('rm')) return finishedProcess({ stdout: ['web-1\n'] });
        return finishedProcess({ stdout: ['up done\n'] });
      };
      const registry = new ComposeRunRegistry();
      const { frames } = await stream('deploy', spawn, { registry, body: { ...validBody('deploy'), forceRecreate: true } });
      const retained = registry.get(String(frames[0].data.runId))?.lastLines.map((l) => l.text);
      expect(retained).toEqual(['up done']);

      expect(cmds.map((c) => c.find((part) => ['config', 'rm', 'up'].includes(part)))).toEqual(['config', 'rm', 'up']);
      expect(frames.filter((f) => f.event === 'phase').map((f) => f.data)).toEqual([
        { seq: 1, phase: 'prepare' },
        { seq: 2, phase: 'up', timeoutMs: 300_000 },
      ]);
      expect(frames.filter((f) => f.event === 'line').map((f) => f.data.text)).toEqual(['up done']);
      expect(JSON.stringify(frames)).not.toContain('hunter2');
    });

    describe('prepare failures are logged without their output', () => {
      const SECRET = 'hunter2';
      const CONFIG_OUT = `services:\n  web:\n    container_name: web-1\n    environment:\n      TOKEN: ${SECRET}\n`;
      let errors: ConsoleSpy;
      let infos: ConsoleSpy;
      const logged = () => [...errors.mock.calls, ...infos.mock.calls].map((args) => args.join(' '));

      beforeEach(() => {
        errors = spyOn(console, 'error').mockImplementation(() => undefined);
        infos = spyOn(console, 'info').mockImplementation(() => undefined);
      });

      afterEach(() => {
        errors.mockRestore();
        infos.mockRestore();
      });

      function fireTimeoutNow(ms: number) {
        const real = globalThis.setTimeout;
        return spyOn(globalThis, 'setTimeout').mockImplementation(
          ((fn: () => void, delay?: number) => real(fn, delay === ms ? 0 : delay)) as unknown as typeof setTimeout,
        );
      }

      const deploy = (spawn: Spawn) => stream('deploy', spawn, { body: { ...validBody('deploy'), forceRecreate: true } });

      test('a failing compose config names the stack, run and exit code', async () => {
        const spawn = (opts: { cmd: string[] }) => (opts.cmd.includes('config')
          ? finishedProcess({ stdout: [CONFIG_OUT], stderr: [`bad value ${SECRET}\n`], exitCode: 15 })
          : finishedProcess());
        const { frames } = await deploy(spawn);
        const line = logged().find((l) => l.includes('docker compose config'));
        expect(line).toContain('for app');
        expect(line).toContain(`run ${String(frames[0].data.runId)}`);
        expect(line).toContain('exited with 15');
        expect(logged().join('\n')).not.toContain(SECRET);
      });

      test('a compose config timeout names the stack and its budget', async () => {
        const timers = fireTimeoutNow(15_000);
        try {
          const spawn = (opts: { cmd: string[] }) => {
            if (!opts.cmd.includes('config')) return finishedProcess();
            const proc = new ControlledProcess();
            proc.write('stdout', CONFIG_OUT);
            return proc;
          };
          await deploy(spawn);
        } finally {
          timers.mockRestore();
        }
        const line = logged().find((l) => l.includes('docker compose config'));
        expect(line).toContain('for app');
        expect(line).toContain('timed out after 15000ms');
        expect(logged().join('\n')).not.toContain(SECRET);
      });

      test('a failing docker rm names the container, stack and exit code', async () => {
        const spawn = (opts: { cmd: string[] }) => {
          if (opts.cmd.includes('config')) return finishedProcess({ stdout: [CONFIG_OUT] });
          if (opts.cmd.includes('rm')) return finishedProcess({ stderr: [`No such container ${SECRET}\n`], exitCode: 1 });
          return finishedProcess();
        };
        await deploy(spawn);
        const line = logged().find((l) => l.includes('docker rm -f web-1'));
        expect(line).toContain('for app');
        expect(line).toContain('exited with 1');
        expect(logged().join('\n')).not.toContain(SECRET);
      });

      test('a docker rm timeout names the container, stack and its budget', async () => {
        const timers = fireTimeoutNow(10_000);
        try {
          const spawn = (opts: { cmd: string[] }) => {
            if (opts.cmd.includes('config')) return finishedProcess({ stdout: [CONFIG_OUT] });
            return opts.cmd.includes('rm') ? new ControlledProcess() : finishedProcess();
          };
          await deploy(spawn);
        } finally {
          timers.mockRestore();
        }
        const line = logged().find((l) => l.includes('docker rm -f web-1'));
        expect(line).toContain('for app');
        expect(line).toContain('timed out after 10000ms');
      });

      test('a prepare step that succeeds logs nothing', async () => {
        const spawn = (opts: { cmd: string[] }) => finishedProcess({ stdout: opts.cmd.includes('config') ? [CONFIG_OUT] : [] });
        await deploy(spawn);
        expect(logged()).toEqual([]);
      });
    });

    test('a spawn failure on a streamed run is logged with its run id', async () => {
      const errors = spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const { frames } = await stream('deploy', () => { throw new Error('docker: not found'); });
        const line = errors.mock.calls.map((args) => args.join(' ')).find((l) => l.startsWith('Failed to execute docker compose'));
        expect(line).toContain(`run ${String(frames[0].data.runId)}`);
      } finally {
        errors.mockRestore();
      }
    });

    test('update carries a give-up on a pipe from either phase into the result', async () => {
      const held = () => ({ exited: Promise.resolve(0), stdout: new ReadableStream<Uint8Array<ArrayBuffer>>(), stderr: new ReadableStream<Uint8Array<ArrayBuffer>>(), kill: () => undefined });
      const registry = new ComposeRunRegistry({ limits: { killGraceMs: 10, drainGraceMs: 10 } });
      let n = 0;
      const { frames } = await stream('update', () => (n++ === 0 ? held() : finishedProcess()), { registry });
      expect(frames.at(-1)?.data).toMatchObject({ status: 'success', outputIncomplete: true });
    });

    test('announces no prepare phase without forceRecreate', async () => {
      const { frames } = await stream('deploy', () => finishedProcess());
      expect(frames.filter((f) => f.event === 'phase').map((f) => f.data.phase)).toEqual(['up']);
    });
  });

  describe('run lifetime', () => {
    async function startAndAbort(registry: ComposeRunRegistry, proc: ControlledProcess, controller: AbortController) {
      const response = await call('deploy', post('deploy', validBody('deploy'), STREAM, controller.signal), () => proc, registry);
      proc.write('stdout', 'before abort\n');
      const seen = await readUntil(response, (text) => text.includes('before abort'));
      const runId = parseEventFrames(seen)[0].data.runId as string;
      return runId;
    }

    test('a client that disconnects mid-run does not kill compose, and the result still lands in the registry', async () => {
      const registry = new ComposeRunRegistry();
      const proc = new ControlledProcess();
      const controller = new AbortController();
      const runId = await startAndAbort(registry, proc, controller);

      controller.abort();
      proc.write('stdout', 'after abort\n');
      proc.exit(0);
      const run = registry.get(runId)!;
      const result = await run.done;

      expect(proc.killed).toBe(0);
      expect(result).toMatchObject({ status: 'success', exitCode: 0, timedOut: false });
      expect(run.result).toEqual(result);
      expect(run.lastLines.map((l) => l.text)).toEqual(['before abort', 'after abort']);
    });

    test('a disconnect before any output leaves the run going too', async () => {
      const registry = new ComposeRunRegistry();
      const proc = new ControlledProcess();
      const controller = new AbortController();
      const response = await call('deploy', post('deploy', validBody('deploy'), STREAM, controller.signal), () => proc, registry);
      controller.abort();
      const runId = parseEventFrames(await readUntil(response, (text) => text.includes('event: start')))[0].data.runId as string;

      proc.exit(5);
      const result = await registry.get(runId)!.done;
      expect(proc.killed).toBe(0);
      expect(result).toMatchObject({ status: 'failed', exitCode: 5, failedPhase: 'up' });
    });

    test('a disconnect does not stop a later timeout from firing', async () => {
      const registry = new ComposeRunRegistry();
      const proc = new ControlledProcess();
      const controller = new AbortController();
      const response = await call('deploy', post('deploy', validBody('deploy'), STREAM, controller.signal), () => proc, registry, 20);
      const seen = await readUntil(response, (text) => text.includes('event: phase'));
      const runId = parseEventFrames(seen)[0].data.runId as string;
      controller.abort();

      const result = await registry.get(runId)!.done;
      expect(proc.killed).toBe(1);
      expect(result).toMatchObject({ timedOut: true });
    });

    test('a streamed result matches what the registry keeps', async () => {
      const registry = new ComposeRunRegistry();
      const { frames } = await stream('deploy', () => finishedProcess({ stdout: ['x\n'] }), { registry });
      const run = registry.get(frames[0].data.runId as string)!;
      expect(run.result as unknown).toEqual(frames.at(-1)?.data);
      expect(run.action).toBe('deploy');
      expect(run.stack).toBe('app');
    });

    test('each streamed request gets its own run id', async () => {
      const registry = new ComposeRunRegistry();
      const a = await stream('deploy', () => finishedProcess(), { registry });
      const b = await stream('deploy', () => finishedProcess(), { registry });
      expect(a.frames[0].data.runId).not.toBe(b.frames[0].data.runId);
      expect(registry.size).toBe(2);
    });
  });
});
