import { mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const VALID_STACK_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const MAX_COMPOSE_SIZE_BYTES = 1_048_576; // 1 MB
const MAX_ENV_SIZE_BYTES = 65_536; // 64 KB

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

/**
 * Deploys a Docker Compose stack described in the request JSON and returns the deployment result.
 *
 * Expects a JSON body with `stack` (name) and `composeContent` (docker-compose YAML); `envContent` is optional.
 *
 * @param stacksDir - Filesystem directory under which per-stack directories are created
 * @param spawn - Optional process spawn function override (defaults to Bun.spawn)
 * @returns A Response whose JSON body indicates the outcome:
 * - On success: `{ status: "success", stdout, stderr }` with HTTP 200.
 * - On failure: either a JSON error message for client errors (e.g., invalid JSON or missing fields) or
 *   `{ status: "failed", exitCode, stdout, stderr }` for process failures with an appropriate HTTP status (e.g., 400 or 500).
 */
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

  if (Buffer.byteLength(body.composeContent) > MAX_COMPOSE_SIZE_BYTES) {
    return Response.json({ error: 'composeContent too large' }, { status: 413 });
  }
  if (body.envContent && Buffer.byteLength(body.envContent) > MAX_ENV_SIZE_BYTES) {
    return Response.json({ error: 'envContent too large' }, { status: 413 });
  }

  const nameError = validateStackName(body.stack);
  if (nameError) return nameError;

  const stackDir = join(stacksDir, body.stack);
  try {
    mkdirSync(stackDir, { recursive: true });
    await Bun.write(join(stackDir, 'docker-compose.yml'), body.composeContent);
    if (body.envContent) {
      await Bun.write(join(stackDir, '.env'), body.envContent);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Failed to write stack files for ${body.stack}:`, error);
    return Response.json({ error: `Failed to write stack files: ${msg}` }, { status: 500 });
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

/**
 * Collects status information for all Docker Compose stacks found in a directory.
 *
 * @param stacksDir - Path to the directory containing stack subdirectories (each expected to include a `docker-compose.yml`).
 * @param spawn - Optional process spawn function used to run Docker Compose commands; defaults to Bun.spawn.
 * @returns A Response whose JSON body is an object `{ stacks }` where `stacks` is an array of objects each containing `name` (the stack directory name) and `containers` (an array of container info parsed from `docker compose ps`; empty if no data or on error).
 */
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
    let error: string | undefined;
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

      const [exitCode, output, stderrOutput] = await Promise.all([
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
            try {
              containers = output.trim().split('\n')
                .filter(line => line.trim())
                .map(line => JSON.parse(line));
            } catch (parseError) {
              console.error(`Failed to parse docker compose ps output for ${entry.name}:`, parseError);
              error = 'Failed to parse status output';
            }
          }
        }
      } else {
        console.error(`docker compose ps failed for ${entry.name} (exit ${exitCode}): ${stderrOutput}`);
        error = stderrOutput.trim() || `Exit code ${exitCode}`;
      }
    } catch (spawnError) {
      console.error(`Failed to get status for stack ${entry.name}:`, spawnError);
      error = spawnError instanceof Error ? spawnError.message : String(spawnError);
    }

    const stackEntry: Record<string, unknown> = { name: entry.name, containers };
    if (error) stackEntry.error = error;
    stacks.push(stackEntry);
  }

  return Response.json({ stacks });
}
