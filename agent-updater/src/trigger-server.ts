import type { AgentUpdater } from './agent-updater';

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

    state.updating = true;
    let check;
    try {
      check = await updater.checkForUpdate();
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
