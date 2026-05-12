import { mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const VALID_STACK_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const MAX_COMPOSE_SIZE_BYTES = 1_048_576; // 1 MB
const MAX_ENV_SIZE_BYTES = 65_536; // 64 KB
const COMPOSE_TIMEOUT_MS = 300_000; // 5 minutes

/** Extract explicit `container_name` values from a compose YAML string. */
export function parseContainerNames(composeContent: string): string[] {
  const regex = /^\s*container_name:\s*["']?([^\s"'#]+)["']?/gm;
  const names: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(composeContent)) !== null) {
    names.push(match[1]);
  }
  return names;
}

/**
 * Validate a stack name and produce an HTTP 400 response when it is missing or invalid.
 *
 * @param name - The candidate stack name; must start with an alphanumeric character and may contain alphanumeric characters, hyphens, and underscores.
 * @returns An HTTP 400 `Response` with an error message when `name` is missing or does not match the allowed pattern, `null` if the name is valid.
 */
function validateStackName(name: string): Response | null {
  if (!name || !VALID_STACK_NAME.test(name)) {
    return Response.json(
      { error: 'Invalid stack name. Must start with alphanumeric and contain only alphanumeric, hyphens, and underscores.' },
      { status: 400 }
    );
  }
  return null;
}

type StackControlBody =
  | { stack: string; scope: 'stack' }
  | { stack: string; scope: 'service'; service: string };

async function parseStackControlBody(request: Request): Promise<StackControlBody | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return Response.json({ error: `Invalid JSON: ${detail}` }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return Response.json({ error: 'Request body must be a JSON object' }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  if (typeof b.stack !== 'string' || !b.stack) {
    return Response.json({ error: 'Missing required field: stack' }, { status: 400 });
  }
  const nameError = validateStackName(b.stack);
  if (nameError) return nameError;

  if (b.scope === 'stack') {
    return { stack: b.stack, scope: 'stack' };
  }
  if (b.scope === 'service') {
    if (typeof b.service !== 'string' || !b.service) {
      return Response.json({ error: 'scope "service" requires a non-empty service field' }, { status: 400 });
    }
    const serviceError = validateStackName(b.service);
    if (serviceError) return serviceError;
    return { stack: b.stack, scope: 'service', service: b.service };
  }
  return Response.json({ error: 'scope must be "stack" or "service"' }, { status: 400 });
}

type SpawnFn = typeof Bun.spawn;

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Spawn a subprocess with a timeout. Kills the process if it exceeds the deadline.
 */
async function spawnWithTimeout(
  spawn: SpawnFn,
  options: { cmd: string[]; cwd?: string; stdout?: 'pipe'; stderr?: 'pipe'; env?: Record<string, string | undefined> },
  timeoutMs: number = COMPOSE_TIMEOUT_MS,
): Promise<SpawnResult> {
  const proc = spawn(options);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill?.(); }, timeoutMs);

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

async function runComposeControl(
  subcommand: 'start' | 'stop' | 'restart',
  parsed: StackControlBody,
  stacksDir: string,
  spawn: SpawnFn,
  timeoutMs: number = COMPOSE_TIMEOUT_MS,
): Promise<Response> {
  const stackDir = join(stacksDir, parsed.stack);
  if (!stackDir.startsWith(stacksDir + '/')) {
    return Response.json({ error: 'Invalid stack path' }, { status: 400 });
  }
  const composePath = join(stackDir, 'docker-compose.yml');
  if (!existsSync(composePath)) {
    return Response.json({ error: `Stack '${parsed.stack}' not found` }, { status: 404 });
  }

  const cmdArgs = subcommand === 'start' ? ['up', '-d'] : [subcommand];
  const cmd = ['docker', 'compose', '-f', composePath, ...cmdArgs];
  if (parsed.scope === 'service') cmd.push(parsed.service);

  let result: SpawnResult;
  try {
    result = await spawnWithTimeout(spawn, {
      cmd,
      cwd: stackDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, COMPOSE_PROJECT_NAME: parsed.stack },
    }, timeoutMs);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Failed to execute docker compose ${subcommand} for ${parsed.stack}:`, error);
    return Response.json({ error: `Failed to execute docker compose: ${msg}` }, { status: 500 });
  }

  return composeResultToResponse(result);
}

/**
 * Validate the deploy request payload and return the parsed body, or an error Response.
 */
async function parseDeployBody(
  request: Request
): Promise<{ stack: string; composeContent: string; envContent?: string; forceRecreate?: boolean } | Response> {
  let body: { stack?: string; composeContent?: string; envContent?: string; forceRecreate?: boolean };
  try {
    const parsed = await request.json();
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return Response.json({ error: 'Request body must be a JSON object' }, { status: 400 });
    }
    body = parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return Response.json({ error: `Invalid JSON: ${detail}` }, { status: 400 });
  }

  if (!body.stack || !body.composeContent) {
    return Response.json({ error: 'Missing required fields: stack, composeContent' }, { status: 400 });
  }

  if (typeof body.stack !== 'string' || typeof body.composeContent !== 'string') {
    return Response.json({ error: 'Fields stack and composeContent must be strings' }, { status: 400 });
  }

  if (body.envContent !== undefined && typeof body.envContent !== 'string') {
    return Response.json({ error: 'Field envContent must be a string' }, { status: 400 });
  }

  if (body.forceRecreate !== undefined && typeof body.forceRecreate !== 'boolean') {
    return Response.json({ error: 'forceRecreate must be a boolean' }, { status: 400 });
  }

  if (Buffer.byteLength(body.composeContent) > MAX_COMPOSE_SIZE_BYTES) {
    return Response.json({ error: 'composeContent too large' }, { status: 413 });
  }
  if (body.envContent && Buffer.byteLength(body.envContent) > MAX_ENV_SIZE_BYTES) {
    return Response.json({ error: 'envContent too large' }, { status: 413 });
  }

  const nameError = validateStackName(body.stack);
  if (nameError) return nameError;

  return { stack: body.stack, composeContent: body.composeContent, envContent: body.envContent, forceRecreate: body.forceRecreate };
}

/**
 * Write compose and optional .env files into the stack directory.
 */
async function writeStackFiles(
  stackDir: string,
  composeContent: string,
  envContent?: string,
): Promise<void> {
  mkdirSync(stackDir, { recursive: true });
  await Bun.write(join(stackDir, 'docker-compose.yml'), composeContent);
  if (envContent) {
    await Bun.write(join(stackDir, '.env'), envContent);
  } else {
    const envPath = join(stackDir, '.env');
    if (existsSync(envPath)) unlinkSync(envPath);
  }
}

/**
 * Convert a SpawnResult into an appropriate HTTP Response.
 */
function composeResultToResponse(result: SpawnResult): Response {
  if (result.timedOut) {
    return Response.json(
      { status: 'failed', exitCode: result.exitCode, stderr: `Process timed out after ${COMPOSE_TIMEOUT_MS / 1000}s. ${result.stderr}`.trim(), stdout: result.stdout },
      { status: 500 }
    );
  }

  if (result.exitCode !== 0) {
    return Response.json(
      { status: 'failed', exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout },
      { status: 500 }
    );
  }

  return Response.json({ status: 'success', stdout: result.stdout, stderr: result.stderr });
}

/**
 * Deploys a Docker Compose stack described in the request JSON and returns the deployment result.
 *
 * Expects a JSON body with `stack` (name) and `composeContent` (docker-compose YAML); `envContent` is optional.
 *
 * @param stacksDir - Filesystem directory under which per-stack directories are created
 * @param spawn - Optional process spawn function override (defaults to Bun.spawn)
 * @returns A Response whose JSON body indicates the outcome:
 * - HTTP 200: `{ status: "success", stdout, stderr }`
 * - HTTP 400: `{ error }` for invalid JSON, missing fields, or invalid stack name
 * - HTTP 413: `{ error }` if `composeContent` exceeds 1 MB or `envContent` exceeds 64 KB
 * - HTTP 500: `{ status: "failed", exitCode, stdout, stderr }` for process failures, or `{ error }` for write/spawn failures
 */
export async function handleStackDeploy(
  request: Request,
  stacksDir: string,
  spawn: SpawnFn = Bun.spawn,
  timeoutMs: number = COMPOSE_TIMEOUT_MS,
): Promise<Response> {
  const parsed = await parseDeployBody(request);
  if (parsed instanceof Response) return parsed;

  const stackDir = join(stacksDir, parsed.stack);
  if (!stackDir.startsWith(stacksDir + '/')) {
    return Response.json({ error: 'Invalid stack path' }, { status: 400 });
  }

  try {
    await writeStackFiles(stackDir, parsed.composeContent, parsed.envContent);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Failed to write stack files for ${parsed.stack}:`, error);
    return Response.json({ error: `Failed to write stack files: ${msg}` }, { status: 500 });
  }

  const composePath = join(stackDir, 'docker-compose.yml');
  const composeEnv = { ...process.env, COMPOSE_PROJECT_NAME: parsed.stack };

  // When force recreate is enabled, remove any containers with explicit
  // container_name values that might conflict: they could belong to a
  // different compose project so `docker compose down` won't touch them.
  if (parsed.forceRecreate) {
    // Resolve env-var interpolations in the compose file (e.g. ${APP_NAME}-web)
    // so that `docker rm -f` targets the actual running container name rather
    // than the literal placeholder string.
    let resolvedContent = parsed.composeContent;
    const tmpDir = process.env.TMPDIR ?? '/tmp';
    const tmpFile = `${tmpDir}/compose-${Date.now()}.yml`;
    try {
      await Bun.write(tmpFile, parsed.composeContent);
      const configResult = await spawnWithTimeout(spawn, {
        cmd: ['docker', 'compose', '--file', tmpFile, 'config'],
        cwd: stackDir,
        stdout: 'pipe',
        stderr: 'pipe',
        env: composeEnv,
      }, 15_000);
      if (configResult.exitCode === 0 && configResult.stdout.trim()) {
        resolvedContent = configResult.stdout;
      }
    } catch (err) {
      console.error(`[forceRecreate] Failed to resolve compose variables for ${parsed.stack}, falling back to raw content:`, err instanceof Error ? err.message : String(err));
    } finally {
      try { unlinkSync(tmpFile); } catch (unlinkErr) {
        console.info(`[forceRecreate] Failed to remove tmp file ${tmpFile}:`, unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr));
      }
    }
    const namedContainers = parseContainerNames(resolvedContent);
    for (const name of namedContainers) {
      try {
        await spawnWithTimeout(spawn, {
          cmd: ['docker', 'rm', '-f', name],
          cwd: stackDir,
          stdout: 'pipe',
          stderr: 'pipe',
          env: composeEnv,
        }, 10_000);
      } catch (err) {
        // spawnWithTimeout only throws on spawn failure (binary missing, fork error),
        // not on non-zero docker exit codes — those are in SpawnResult.exitCode.
        console.error(`[forceRecreate] Failed to spawn docker rm for '${name}':`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  const cmd = ['docker', 'compose', '-f', composePath, 'up', '-d', '--remove-orphans'];
  if (parsed.forceRecreate) cmd.push('--force-recreate');

  let result: SpawnResult;
  try {
    result = await spawnWithTimeout(spawn, {
      cmd,
      cwd: stackDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: composeEnv,
    }, timeoutMs);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Failed to execute docker compose for ${parsed.stack}:`, error);
    return Response.json({ error: `Failed to execute docker compose: ${msg}` }, { status: 500 });
  }

  return composeResultToResponse(result);
}

/**
 * Tear down a Docker Compose stack identified in the request body by running `docker compose down`.
 *
 * Expects a JSON body with a `stack` field. Returns a 400 response for invalid JSON or a missing `stack` field, a 404 response if the stack's docker-compose.yml is not found, and a 500 response with execution details if the compose command fails.
 *
 * @param stacksDir - Filesystem directory under which stack subdirectories (each containing a docker-compose.yml) are located
 * @param spawn - Optional process spawn function used to invoke the compose command
 * @returns On success, a JSON response with `{ status: "success", stdout, stderr }`. On failure due to the compose command, a JSON response with `{ status: "failed", exitCode, stdout, stderr }`. Error responses for bad input or missing stack use appropriate HTTP status codes and an `error` message.
 */
export async function handleStackTeardown(
  request: Request,
  stacksDir: string,
  spawn: SpawnFn = Bun.spawn,
  timeoutMs: number = COMPOSE_TIMEOUT_MS,
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
  if (!stackDir.startsWith(stacksDir + '/')) {
    return Response.json({ error: 'Invalid stack path' }, { status: 400 });
  }
  const composePath = join(stackDir, 'docker-compose.yml');

  if (!existsSync(composePath)) {
    return Response.json(
      { error: `Stack '${body.stack}' not found` },
      { status: 404 }
    );
  }

  let result: SpawnResult;
  try {
    result = await spawnWithTimeout(spawn, {
      cmd: ['docker', 'compose', '-f', composePath, 'down'],
      cwd: stackDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, COMPOSE_PROJECT_NAME: body.stack },
    }, timeoutMs);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Failed to execute docker compose for ${body.stack}:`, error);
    return Response.json({ error: `Failed to execute docker compose: ${msg}` }, { status: 500 });
  }

  return composeResultToResponse(result);
}

export async function handleStackRestart(
  request: Request,
  stacksDir: string,
  spawn: SpawnFn = Bun.spawn,
  timeoutMs: number = COMPOSE_TIMEOUT_MS,
): Promise<Response> {
  const parsed = await parseStackControlBody(request);
  if (parsed instanceof Response) return parsed;
  return runComposeControl('restart', parsed, stacksDir, spawn, timeoutMs);
}

export async function handleStackStart(
  request: Request,
  stacksDir: string,
  spawn: SpawnFn = Bun.spawn,
  timeoutMs: number = COMPOSE_TIMEOUT_MS,
): Promise<Response> {
  const parsed = await parseStackControlBody(request);
  if (parsed instanceof Response) return parsed;
  return runComposeControl('start', parsed, stacksDir, spawn, timeoutMs);
}

export async function handleStackStop(
  request: Request,
  stacksDir: string,
  spawn: SpawnFn = Bun.spawn,
  timeoutMs: number = COMPOSE_TIMEOUT_MS,
): Promise<Response> {
  const parsed = await parseStackControlBody(request);
  if (parsed instanceof Response) return parsed;
  return runComposeControl('stop', parsed, stacksDir, spawn, timeoutMs);
}

/**
 * Parse Docker Compose ps output, handling both JSON array and NDJSON formats.
 */
function parseComposeOutput(output: string, stackName: string): { containers: unknown[]; error?: string } {
  const trimmed = output.trim();
  if (!trimmed) return { containers: [] };

  try {
    const parsed = JSON.parse(trimmed);
    return { containers: Array.isArray(parsed) ? parsed : [parsed] };
  } catch {
    // JSON array parse failed, trying NDJSON (Docker outputs vary by version)
  }

  try {
    const containers = trimmed.split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
    return { containers };
  } catch (parseError) {
    console.error(`Failed to parse docker compose ps output for ${stackName}:`, parseError);
    return { containers: [], error: 'Failed to parse status output' };
  }
}

/**
 * Collect status for a single stack by running `docker compose ps`.
 */
async function collectStackStatus(
  stacksDir: string,
  stackName: string,
  spawn: SpawnFn,
  timeoutMs?: number,
): Promise<{ name: string; containers: unknown[]; error?: string }> {
  const composePath = join(stacksDir, stackName, 'docker-compose.yml');

  const effectiveMs = timeoutMs ?? COMPOSE_TIMEOUT_MS;
  const result = await spawnWithTimeout(spawn, {
    cmd: ['docker', 'compose', '-f', composePath, 'ps', '--format', 'json'],
    cwd: join(stacksDir, stackName),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, COMPOSE_PROJECT_NAME: stackName },
  }, timeoutMs);

  if (result.timedOut) {
    console.error(`docker compose ps timed out for ${stackName}`);
    return { name: stackName, containers: [], error: `Process timed out after ${effectiveMs / 1000}s` };
  }

  if (result.exitCode !== 0) {
    console.error(`docker compose ps failed for ${stackName} (exit ${result.exitCode}): ${result.stderr}`);
    return { name: stackName, containers: [], error: result.stderr.trim() || `Exit code ${result.exitCode}` };
  }

  const { containers, error } = parseComposeOutput(result.stdout, stackName);
  return { name: stackName, containers, ...(error ? { error } : {}) };
}

/**
 * Collects status information for all Docker Compose stacks found in a directory.
 *
 * @param stacksDir - Path to the directory containing stack subdirectories (each expected to include a `docker-compose.yml`).
 * @param spawn - Optional process spawn function used to run Docker Compose commands; defaults to Bun.spawn.
 * @returns A Response whose JSON body is `{ stacks, hasErrors? }` where `stacks` is an array of objects
 *   each containing `name`, `containers` (parsed from `docker compose ps`; empty on error),
 *   and optionally `error` (a string describing why status retrieval failed).
 *   `hasErrors` is `true` when any stack encountered an error.
 */
export async function handleStackStatus(
  stacksDir: string,
  spawn: SpawnFn = Bun.spawn,
  timeoutMs?: number,
): Promise<Response> {
  if (!existsSync(stacksDir)) {
    return Response.json({ stacks: [] });
  }

  let entries;
  try {
    entries = readdirSync(stacksDir, { withFileTypes: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to read stacks directory '${stacksDir}':`, err);
    return Response.json({ error: `Failed to read stacks directory: ${msg}` }, { status: 500 });
  }

  const stackDirs = entries.filter(
    (entry) => entry.isDirectory() && VALID_STACK_NAME.test(entry.name) && existsSync(join(stacksDir, entry.name, 'docker-compose.yml'))
  );

  const results = await Promise.allSettled(
    stackDirs.map(async (entry) => {
      try {
        return await collectStackStatus(stacksDir, entry.name, spawn, timeoutMs);
      } catch (spawnError) {
        console.error(`Failed to get status for stack ${entry.name}:`, spawnError);
        const error = spawnError instanceof Error ? spawnError.message : String(spawnError);
        return { name: entry.name, containers: [] as unknown[], error };
      }
    })
  );

  const stacks = results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { name: stackDirs[i].name, containers: [], error: String((r as PromiseRejectedResult).reason) }
  );
  const hasErrors = stacks.some(s => 'error' in s);

  return Response.json({ stacks, ...(hasErrors ? { hasErrors: true } : {}) });
}
