import { mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const VALID_STACK_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const MAX_COMPOSE_SIZE_BYTES = 1_048_576; // 1 MB
const MAX_ENV_SIZE_BYTES = 65_536; // 64 KB
const COMPOSE_TIMEOUT_MS = 300_000; // 5 minutes

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

/**
 * Validate the deploy request payload and return the parsed body, or an error Response.
 */
async function parseDeployBody(
  request: Request
): Promise<{ stack: string; composeContent: string; envContent?: string } | Response> {
  let body: { stack?: string; composeContent?: string; envContent?: string };
  try {
    body = await request.json();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return Response.json({ error: `Invalid JSON: ${detail}` }, { status: 400 });
  }

  if (!body.stack || !body.composeContent) {
    return Response.json({ error: 'Missing required fields: stack, composeContent' }, { status: 400 });
  }

  if (Buffer.byteLength(body.composeContent) > MAX_COMPOSE_SIZE_BYTES) {
    return Response.json({ error: 'composeContent too large' }, { status: 413 });
  }
  if (body.envContent && Buffer.byteLength(body.envContent) > MAX_ENV_SIZE_BYTES) {
    return Response.json({ error: 'envContent too large' }, { status: 413 });
  }

  const nameError = validateStackName(body.stack);
  if (nameError) return nameError;

  return { stack: body.stack, composeContent: body.composeContent, envContent: body.envContent };
}

/**
 * Write compose and optional .env files into the stack directory.
 */
async function writeStackFiles(
  stackDir: string,
  composeContent: string,
  envContent?: string,
): Promise<Response | null> {
  mkdirSync(stackDir, { recursive: true });
  await Bun.write(join(stackDir, 'docker-compose.yml'), composeContent);
  if (envContent) {
    await Bun.write(join(stackDir, '.env'), envContent);
  } else {
    const envPath = join(stackDir, '.env');
    if (existsSync(envPath)) unlinkSync(envPath);
  }
  return null;
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

  let result: SpawnResult;
  try {
    result = await spawnWithTimeout(spawn, {
      cmd: ['docker', 'compose', '-f', join(stackDir, 'docker-compose.yml'), 'up', '-d', '--remove-orphans'],
      cwd: stackDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, COMPOSE_PROJECT_NAME: parsed.stack },
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

/**
 * Restart the Docker Compose stack specified in the request body.
 *
 * Parses JSON from the request expecting a `stack` name, validates the name,
 * ensures the stack's docker-compose.yml exists under `stacksDir`, and runs
 * `docker compose -f <composePath> restart` with `COMPOSE_PROJECT_NAME` set to
 * the stack name.
 *
 * @param request - HTTP request whose JSON body must include `stack`
 * @param stacksDir - Path to the directory containing stack subdirectories
 * @param spawn - Optional process spawn function used to run Docker commands
 * @returns On success, a 200 Response with `{ status: "success", stdout, stderr }`.
 *          If the Docker command exits non-zero, a 500 Response with
 *          `{ status: "failed", exitCode, stdout, stderr }`.
 *          Returns 400 with `{ error: ... }` for invalid JSON or missing `stack`,
 *          and 404 with `{ error: ... }` if the stack's compose file is not found.
 */
export async function handleStackRestart(
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
      cmd: ['docker', 'compose', '-f', composePath, 'restart'],
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
): Promise<{ name: string; containers: unknown[]; error?: string }> {
  const composePath = join(stacksDir, stackName, 'docker-compose.yml');

  const proc = spawn({
    cmd: ['docker', 'compose', '-f', composePath, 'ps', '--format', 'json'],
    cwd: join(stacksDir, stackName),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, COMPOSE_PROJECT_NAME: stackName },
  });

  const [exitCode, output, stderrOutput] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    console.error(`docker compose ps failed for ${stackName} (exit ${exitCode}): ${stderrOutput}`);
    return { name: stackName, containers: [], error: stderrOutput.trim() || `Exit code ${exitCode}` };
  }

  const { containers, error } = parseComposeOutput(output, stackName);
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
  spawn: SpawnFn = Bun.spawn
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
        return await collectStackStatus(stacksDir, entry.name, spawn);
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
