import type { AgentUpdater } from './agent-updater';

export interface TriggerState {
  updating: boolean;
}

export interface TriggerAuth {
  // Shared secret the relay must present. Undefined disables the endpoint: an unauthenticated caller must never be able to run Docker writes.
  token?: string;
}

export function createTriggerState(): TriggerState {
  return { updating: false };
}

// Answers 202 before pulling: the update stops this container's sibling, so the caller must get its response first.
export function createTriggerHandler(
  updater: AgentUpdater,
  state: TriggerState = createTriggerState(),
  auth: TriggerAuth = {},
) {
  return async function handleTriggerRequest(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    if (!auth.token) {
      return plainText('Update trigger is not configured on this agent-updater. Regenerate the compose stack to set the trigger token.', 503);
    }
    if (request.headers.get('authorization') !== 'Bearer ' + auth.token) {
      return plainText('Update trigger authorization failed', 401);
    }

    if (state.updating) {
      return plainText('An update is already in progress', 409);
    }

    state.updating = true;
    let check;
    try {
      check = await updater.checkForUpdate();
    } catch (error) {
      // checkForUpdate resolves checkFailed on its own errors, so this only fires on an unexpected throw. Reset the busy flag either way.
      state.updating = false;
      console.error('Triggered update check threw:', error instanceof Error ? error.message : error);
      return plainText('Update check failed. Verify the agent host can reach the image registry, then retry the update.', 503);
    }

    if (check.checkFailed) {
      state.updating = false;
      // Plain text on purpose: the manager surfaces this body verbatim as the update result error.
      return plainText('Update check failed. Verify the agent host can reach the image registry, then retry the update.', 503);
    }

    if (!check.updateAvailable) {
      state.updating = false;
      return Response.json({ updateAvailable: false, currentDigest: check.currentDigest ?? null });
    }

    void updater.performUpdate()
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

function plainText(message: string, status: number): Response {
  return new Response(message, { status });
}
