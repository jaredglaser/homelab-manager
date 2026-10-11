import type { AgentUpdater } from './agent-updater';

// Digest-only target: a floating tag would let the sidecar converge to an image newer than the manager itself runs.
const DIGEST_REF_PATTERN = /@sha256:[0-9a-f]{64}$/;

export interface TriggerState {
  updating: boolean;
}

export function createTriggerState(): TriggerState {
  return { updating: false };
}

// Answers 202 before pulling: the update stops this container's sibling, so the caller must get its response first.
export function createTriggerHandler(updater: AgentUpdater, state: TriggerState = createTriggerState()) {
  return async function handleTriggerRequest(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    if (state.updating) {
      return Response.json({ error: 'An update is already in progress' }, { status: 409 });
    }

    let body: { targetImage?: unknown } | null = null;
    try {
      body = (await request.json()) as { targetImage?: unknown };
    } catch {
      body = null;
    }
    let targetImage: string | undefined;
    if (body?.targetImage !== undefined) {
      // Absent targetImage keeps the legacy floating-tag path for already-deployed relays.
      if (typeof body.targetImage !== 'string' || !DIGEST_REF_PATTERN.test(body.targetImage)) {
        return Response.json(
          { error: 'targetImage must be an image reference pinned to a sha256 digest' },
          { status: 400 },
        );
      }
      targetImage = body.targetImage;
    }

    state.updating = true;
    let check;
    try {
      check = await updater.checkForUpdate(targetImage);
    } catch (error) {
      state.updating = false;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Triggered update check failed: ${message}`);
      return Response.json({ error: message }, { status: 500 });
    }

    if (!check.updateAvailable) {
      state.updating = false;
      return Response.json({ updateAvailable: false, currentDigest: check.currentDigest ?? null });
    }

    void updater.performUpdate(targetImage)
      .then((result) => {
        if (result.success) {
          console.info(`Triggered update completed: ${result.previousImage} → ${result.newImage}`);
        } else {
          console.error(`Triggered update failed: ${result.error}${result.rolledBack ? ' (rolled back)' : ''}`);
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Triggered update crashed: ${message}`);
      })
      .finally(() => {
        state.updating = false;
      });

    return Response.json({ started: true }, { status: 202 });
  };
}
