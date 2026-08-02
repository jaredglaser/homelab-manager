import { createServerFn } from '@tanstack/react-start';
import { authMiddleware } from '@/middleware/auth-middleware';
import { requireRole } from '@/lib/auth/require-role';
import {
  startAnsibleRunSchema,
  cancelAnsibleRunSchema,
  listAnsibleRunsSchema,
} from '@/data/ansible/schemas';
import {
  ANSIBLE_SECRET_SCOPE,
  handleStartRun,
  handleListRuns,
  handleCancelRun,
  type AnsibleHandlerDeps,
} from '@/data/ansible/handlers';
import type { AnsibleRun } from '@/types/ansible';

async function loadDeps(): Promise<AnsibleHandlerDeps> {
  const { loadAnsibleConfig } = await import('@/lib/config/ansible-config');
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { AnsibleRunRepository } = await import(
    '@/lib/database/repositories/ansible-run-repository'
  );
  const { StackSecretsRepository } = await import(
    '@/lib/database/repositories/stack-secrets-repository'
  );
  const { loadMasterKeyring } = await import('@/lib/crypto/master-key');
  const { SidecarClient } = await import('@/lib/ansible/sidecar-client');
  const { AnsibleRunService } = await import('@/lib/ansible/run-service');
  const { ansibleRunBroadcastService } = await import('@/lib/ansible/run-broadcast-service');

  const config = loadAnsibleConfig();
  const pool = (await databaseConnectionManager.getClient(loadDatabaseConfig())).getPool();
  const repo = new AnsibleRunRepository(pool);
  const secrets = new StackSecretsRepository(pool, await loadMasterKeyring());

  return {
    repo,
    service: new AnsibleRunService({
      repo,
      client: new SidecarClient(config),
      publish: (event) => ansibleRunBroadcastService.publish(event),
    }),
    loadSecrets: () => secrets.getAll(ANSIBLE_SECRET_SCOPE),
  };
}

export const startAnsibleRun = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(startAnsibleRunSchema)
  .handler(async ({ data, context }): Promise<AnsibleRun> => {
    requireRole('admin')(context.user);
    return handleStartRun({ ...data, requestedBy: context.user.email }, await loadDeps());
  });

export const listAnsibleRuns = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(listAnsibleRunsSchema)
  .handler(async ({ data, context }): Promise<AnsibleRun[]> => {
    requireRole('admin')(context.user);
    return handleListRuns(data.limit, await loadDeps());
  });

export const cancelAnsibleRun = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(cancelAnsibleRunSchema)
  .handler(async ({ data, context }): Promise<{ cancelled: boolean }> => {
    requireRole('admin')(context.user);
    return handleCancelRun(data.runId, await loadDeps());
  });
