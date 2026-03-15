import { mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const VALID_STACK_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function validateStackName(name: string): Response | null {
  if (!name || !VALID_STACK_NAME.test(name)) {
    return Response.json(
      { error: 'Invalid stack name. Must start with alphanumeric and contain only alphanumeric, hyphens, and underscores.' },
      { status: 400 }
    );
  }
  return null;
}

type SpawnFn = typeof Bun.spawn;

export async function handleStackDeploy(
  request: Request,
  stacksDir: string,
  spawn: SpawnFn = Bun.spawn
): Promise<Response> {
  let body: { stack?: string; composeContent?: string; envContent?: string };
  try {
    body = await request.json();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return Response.json({ error: `Invalid JSON: ${detail}` }, { status: 400 });
  }

  if (!body.stack || !body.composeContent) {
    return Response.json(
      { error: 'Missing required fields: stack, composeContent' },
      { status: 400 }
    );
  }

  const nameError = validateStackName(body.stack);
  if (nameError) return nameError;

  const stackDir = join(stacksDir, body.stack);
  mkdirSync(stackDir, { recursive: true });

  await Bun.write(join(stackDir, 'docker-compose.yml'), body.composeContent);

  if (body.envContent) {
    await Bun.write(join(stackDir, '.env'), body.envContent);
  }

  const proc = spawn({
    cmd: [
      'docker',
      'compose',
      '-f',
      join(stackDir, 'docker-compose.yml'),
      'up',
      '-d',
      '--remove-orphans',
    ],
    cwd: stackDir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, COMPOSE_PROJECT_NAME: body.stack },
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    return Response.json(
      { status: 'failed', exitCode, stderr, stdout },
      { status: 500 }
    );
  }

  return Response.json({ status: 'success', stdout, stderr });
}

export async function handleStackTeardown(
  request: Request,
  stacksDir: string,
  spawn: SpawnFn = Bun.spawn
): Promise<Response> {
  let body: { stack?: string };
  try {
    body = await request.json();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return Response.json({ error: `Invalid JSON: ${detail}` }, { status: 400 });
  }

  if (!body.stack) {
    return Response.json(
      { error: 'Missing required field: stack' },
      { status: 400 }
    );
  }

  const nameError = validateStackName(body.stack);
  if (nameError) return nameError;

  const stackDir = join(stacksDir, body.stack);
  const composePath = join(stackDir, 'docker-compose.yml');

  if (!existsSync(composePath)) {
    return Response.json(
      { error: `Stack '${body.stack}' not found` },
      { status: 404 }
    );
  }

  const proc = spawn({
    cmd: ['docker', 'compose', '-f', composePath, 'down'],
    cwd: stackDir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, COMPOSE_PROJECT_NAME: body.stack },
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    return Response.json(
      { status: 'failed', exitCode, stderr, stdout },
      { status: 500 }
    );
  }

  return Response.json({ status: 'success', stdout, stderr });
}

export async function handleStackRestart(
  request: Request,
  stacksDir: string,
  spawn: SpawnFn = Bun.spawn
): Promise<Response> {
  let body: { stack?: string };
  try {
    body = await request.json();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return Response.json({ error: `Invalid JSON: ${detail}` }, { status: 400 });
  }

  if (!body.stack) {
    return Response.json(
      { error: 'Missing required field: stack' },
      { status: 400 }
    );
  }

  const nameError2 = validateStackName(body.stack);
  if (nameError2) return nameError2;

  const stackDir = join(stacksDir, body.stack);
  const composePath = join(stackDir, 'docker-compose.yml');

  if (!existsSync(composePath)) {
    return Response.json(
      { error: `Stack '${body.stack}' not found` },
      { status: 404 }
    );
  }

  const proc = spawn({
    cmd: ['docker', 'compose', '-f', composePath, 'restart'],
    cwd: stackDir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, COMPOSE_PROJECT_NAME: body.stack },
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    return Response.json(
      { status: 'failed', exitCode, stderr, stdout },
      { status: 500 }
    );
  }

  return Response.json({ status: 'success', stdout, stderr });
}

export async function handleStackStatus(
  stacksDir: string,
  spawn: SpawnFn = Bun.spawn
): Promise<Response> {
  if (!existsSync(stacksDir)) {
    return Response.json({ stacks: [] });
  }

  const entries = readdirSync(stacksDir, { withFileTypes: true });
  const stacks = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const composePath = join(stacksDir, entry.name, 'docker-compose.yml');
    if (!existsSync(composePath)) continue;

    let containers: unknown[] = [];
    try {
      const proc = spawn({
        cmd: [
          'docker',
          'compose',
          '-f',
          composePath,
          'ps',
          '--format',
          'json',
        ],
        cwd: join(stacksDir, entry.name),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, COMPOSE_PROJECT_NAME: entry.name },
      });

      const [exitCode, output] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      if (exitCode === 0) {
        if (output.trim()) {
          try {
            const parsed = JSON.parse(output);
            containers = Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            containers = output.trim().split('\n')
              .filter(line => line.trim())
              .map(line => JSON.parse(line));
          }
        }
      }
    } catch {
      // docker compose ps may fail (stack not running, spawn error, etc.)
    }

    stacks.push({
      name: entry.name,
      containers,
    });
  }

  return Response.json({ stacks });
}
