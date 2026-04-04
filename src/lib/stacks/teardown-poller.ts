/**
 * Teardown polling logic — separated for unit testability.
 * Used by stack-service internally via teardownAndAwait.
 */

const TEARDOWN_POLL_INTERVAL_MS = 1_000;
const TEARDOWN_POLL_TIMEOUT_MS = 120_000;
const TERMINAL_DEPLOY_STATUSES = new Set(['succeeded', 'failed', 'no_change']);

export interface TeardownDeps {
  deployRepo: { getById: (id: number) => Promise<{ status: string; logs?: string | null } | null> };
  triggerDeploy: (params: { stack: string; host: string; action: 'teardown' }) => Promise<{ deployId: number }>;
}

/** Trigger teardown and poll until terminal status, using injected dependencies. */
export async function teardownAndAwaitWithDeps(
  stackName: string,
  host: string,
  deps: TeardownDeps,
): Promise<void> {
  const { deployId } = await deps.triggerDeploy({ stack: stackName, host, action: 'teardown' });
  const start = Date.now();
  let record = await deps.deployRepo.getById(deployId);
  while (record && !TERMINAL_DEPLOY_STATUSES.has(record.status)) {
    if (Date.now() - start > TEARDOWN_POLL_TIMEOUT_MS) {
      throw new Error(`Teardown timed out after ${TEARDOWN_POLL_TIMEOUT_MS / 1_000}s. Stack not deleted.`);
    }
    await new Promise((r) => setTimeout(r, TEARDOWN_POLL_INTERVAL_MS));
    record = await deps.deployRepo.getById(deployId);
  }
  if (record && record.status === 'failed') {
    throw new Error(`Teardown failed: ${record.logs ?? 'unknown error'}. Stack not deleted.`);
  }
}
