import type Dockerode from 'dockerode';
import { resolveRunningAgentReference } from '../lib/agent-image';
import { spawnUpdateHelper } from '../lib/self-update';

// Full anchored Docker ref grammar: optional registry host with optional port,
// lowercase path segments, then at-sha256 with exactly 64 hex.
const DIGEST_REF_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[0-9]+)?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/;

// Two overlapping applies would race two helper containers. The window only has to
// cover one handover, and an agent restart clears it.
const UPDATE_IN_PROGRESS_WINDOW_MS = 10 * 60_000;
let lastUpdateTriggeredAt = 0;

/** Test seam: clears the in-progress guard so tests are order-independent. */
export function resetUpdateInProgressGuard(): void {
  lastUpdateTriggeredAt = 0;
}

// Digest-only contract: a floating tag here would let the helper converge to an image newer than the manager itself runs.
export async function handleAgentUpdate(
  docker: Dockerode | null,
  containerName: string,
  agentPort: number,
  request: Request,
): Promise<Response> {
  if (!docker) {
    return Response.json(
      {
        error:
          'Agent updates require Docker capability, which this agent does not have. Update it manually: run `docker compose pull && docker compose up -d` in the agent stack directory.',
      },
      { status: 503 },
    );
  }

  let body: { targetImage?: unknown };
  try {
    body = (await request.json()) as { targetImage?: unknown };
  } catch {
    return Response.json(
      { error: 'Agent update requires a JSON body with a digest-pinned targetImage' },
      { status: 400 },
    );
  }
  if (typeof body?.targetImage !== 'string' || !DIGEST_REF_PATTERN.test(body.targetImage)) {
    return Response.json(
      { error: 'targetImage must be an image reference pinned to a sha256 digest' },
      { status: 400 },
    );
  }

  const running = await resolveRunningAgentReference(docker, containerName);
  const targetRepo = body.targetImage.split('@')[0];
  if (running && running.repo !== targetRepo) {
    return Response.json(
      { error: 'The requested update target does not belong to the image repository this agent runs from' },
      { status: 400 },
    );
  }
  const currentDigest = running ? running.digest : null;
  const targetDigest = body.targetImage.split('@')[1];
  if (currentDigest !== null && currentDigest === targetDigest) {
    return Response.json({ updateAvailable: false });
  }

  if (Date.now() - lastUpdateTriggeredAt < UPDATE_IN_PROGRESS_WINDOW_MS) {
    return Response.json({ error: 'An update is already in progress' }, { status: 409 });
  }
  // Set before any await: two concurrent requests must not both get past the guard above.
  lastUpdateTriggeredAt = Date.now();

  try {
    await spawnUpdateHelper(docker, {
      containerName,
      targetImage: body.targetImage,
      agentPort,
      dockerHost: process.env.DOCKER_HOST,
    });
  } catch (error) {
    // A failed spawn left no helper behind, so a retry must not wait out the window.
    lastUpdateTriggeredAt = 0;
    return Response.json(
      {
        error: `Could not start the agent update: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 500 },
    );
  }

  return Response.json({ started: true }, { status: 202 });
}
