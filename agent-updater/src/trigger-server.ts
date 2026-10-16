import type { AgentUpdater } from './agent-updater';

// Digest-only target: a floating tag would let the sidecar converge to an image newer than the manager itself runs.
const DIGEST_REF_PATTERN = /@sha256:[0-9a-f]{64}$/;

export interface TriggerState {
  updating: boolean;
}

export interface TriggerAuth {
  // Shared secret the relay must present. Undefined disables the endpoint: an unauthenticated caller must never be able to run Docker writes.
  token?: string;
}

export interface TriggerTargets {
  // Repo prefixes (registry/repository) the pinned targets must belong to; watchedRepoPrefix comes from the watched image ref, selfRepoPrefix from the sidecar's own image ref.
  watchedRepoPrefix?: string;
  selfRepoPrefix?: string;
}

export function createTriggerState(): TriggerState {
  return { updating: false };
}

// The image reference minus its tag or digest: everything up to the last colon that sits after the last slash.
export function repoPrefix(imageRef: string): string {
  if (imageRef.includes('@')) return imageRef.split('@')[0];
  const colon = imageRef.lastIndexOf(':');
  const slash = imageRef.lastIndexOf('/');
  if (colon > slash) return imageRef.slice(0, colon);
  return imageRef;
}

// Answers 202 before pulling: the update stops this container's sibling, so the caller must get its response first.
export function createTriggerHandler(
  updater: AgentUpdater,
  state: TriggerState = createTriggerState(),
  options: TriggerAuth & TriggerTargets = {},
) {
  return async function handleTriggerRequest(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    if (!options.token) {
      return plainText('Update trigger is not configured on this agent-updater. Regenerate the compose stack to set the trigger token.', 503);
    }
    if (request.headers.get('authorization') !== 'Bearer ' + options.token) {
      return plainText('Update trigger authorization failed', 401);
    }

    if (state.updating) {
      return plainText('An update is already in progress', 409);
    }
    // Set before any await: two concurrent triggers must not both get past the guard above.
    state.updating = true;

    let body: { targetImage?: unknown; updaterTargetImage?: unknown } | null = null;
    try {
      body = (await request.json()) as { targetImage?: unknown; updaterTargetImage?: unknown };
    } catch {
      body = null;
    }
    let targetImage: string | undefined;
    if (body?.targetImage !== undefined) {
      // Absent targetImage keeps the legacy floating-tag path for already-deployed relays.
      if (typeof body.targetImage !== 'string' || !DIGEST_REF_PATTERN.test(body.targetImage)) {
        state.updating = false;
        return Response.json(
          { error: 'targetImage must be an image reference pinned to a sha256 digest' },
          { status: 400 },
        );
      }
      if (options.watchedRepoPrefix && !body.targetImage.startsWith(options.watchedRepoPrefix + '@')) {
        state.updating = false;
        return plainText('The requested update target does not belong to the configured agent image repository', 400);
      }
      targetImage = body.targetImage;
    }
    let updaterTargetImage: string | undefined;
    if (body?.updaterTargetImage !== undefined && body?.updaterTargetImage !== null) {
      // null means the manager could not pin the updater image this round: skip the self-recreate, keep serving.
      if (typeof body.updaterTargetImage !== 'string' || !DIGEST_REF_PATTERN.test(body.updaterTargetImage)) {
        state.updating = false;
        return Response.json(
          { error: 'updaterTargetImage must be an image reference pinned to a sha256 digest' },
          { status: 400 },
        );
      }
      if (!options.selfRepoPrefix) {
        state.updating = false;
        return plainText('The sidecar cannot verify the updater target because its own image reference is not configured', 400);
      }
      if (!body.updaterTargetImage.startsWith(options.selfRepoPrefix + '@')) {
        state.updating = false;
        return plainText('The requested updater target does not belong to the configured agent-updater image repository', 400);
      }
      updaterTargetImage = body.updaterTargetImage;
    }

    let check;
    try {
      check = await updater.isUpToDate(targetImage);
    } catch (error) {
      // isUpToDate resolves checkFailed on its own errors, so this only fires on an unexpected throw. Reset the busy flag either way.
      state.updating = false;
      console.error('Triggered update check threw:', error instanceof Error ? error.message : error);
      return plainText('Update check failed. Verify the agent host can reach the image registry, then retry the update.', 503);
    }

    if (check.checkFailed) {
      state.updating = false;
      // Plain text on purpose: the manager surfaces this body verbatim as the update result error.
      return plainText('Update check failed. Verify the agent host can reach the image registry, then retry the update.', 503);
    }

    if (check.upToDate) {
      state.updating = false;
      return Response.json({ updateAvailable: false, currentDigest: check.currentDigest ?? null });
    }

    void updater.performUpdate(targetImage)
      .then(async (result) => {
        if (result.success) {
          console.info(`Triggered update completed: ${result.previousImage} → ${result.newImage}`);
          if (updaterTargetImage) {
            const self = await updater.recreateSelf(updaterTargetImage);
            if (self.recreated) {
              // The replacement container serves the trigger endpoint from here: this process only gets in its way.
              console.info('Sidecar self-recreate done, exiting so the new container takes over');
              process.exit(0);
            }
            if (self.reason) console.info(`Sidecar self-recreate skipped: ${self.reason}`);
          }
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

function plainText(message: string, status: number): Response {
  return new Response(message, { status });
}
