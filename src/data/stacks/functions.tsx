import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type {
  StackSummary,
  StackDetail,
  StackDeployRecord,
  DeployStatus,
  StackDriftReport,
  StackDriftResolutionResult,
} from '@/types/stacks';
import { stackSecretsMiddleware } from '@/middleware/stack-secrets-middleware';
import type { StackControlRequest } from '@/lib/clients/agent-client';
import { authMiddleware } from '@/middleware/auth-middleware';
import { requireRole } from '@/lib/auth/require-role';
import {
  getStackDetailSchema,
  triggerDeploySchema,
  getDeployHistorySchema,
  saveComposeFileSchema,
  resumeDeploySchema,
  rejectDeploySchema,
  controlStackSchema,
  resolveDriftSchema,
} from '@/data/stacks/schemas';

/**
 * List all stacks from the manifest with their current sync status.
 * Reads the manifest via isomorphic-git, cross-references deploy_history for status.
 */
export const listStacks = createServerFn()
  .middleware([authMiddleware])
  .handler(async (): Promise<StackSummary[]> => {
    const { getStackSummaries } = await import('@/lib/stacks/stack-service');
    return getStackSummaries();
  });

/**
 * Get full detail for a single stack, including compose file content and variables.
 */
export const getStackDetail = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(getStackDetailSchema)
  .handler(async ({ data }): Promise<StackDetail | null> => {
    const { getStackDetailByName } = await import('@/lib/stacks/stack-service');
    return getStackDetailByName(data.stackName);
  });



/**
 * Trigger a deploy or teardown for a stack.
 * Pass an optional commitSha to perform a rollback to that specific commit.
 */
export const triggerDeploy = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(triggerDeploySchema)
  .handler(async ({ data, context }): Promise<{ deployId: number; status: DeployStatus; logs: string }> => {
    requireRole('admin', 'operator')(context.user);
    const { triggerStackDeploy } = await import('@/lib/stacks/stack-service');
    return triggerStackDeploy(data);
  });

/** Approves a pending deploy via the pipeline's resumePending path. */
export const resumeDeploy = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(resumeDeploySchema)
  .handler(async ({ data, context }): Promise<{ deployId: number; status: DeployStatus; logs: string }> => {
    requireRole('admin', 'operator')(context.user);
    const { resumePendingDeploy } = await import('@/lib/stacks/stack-service');
    return resumePendingDeploy(data.deployId);
  });

/** Rejects a pending deploy, marking it failed with a "Manually rejected" log. */
export const rejectDeploy = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(rejectDeploySchema)
  .handler(async ({ data, context }): Promise<{ deployId: number }> => {
    requireRole('admin', 'operator')(context.user);
    const { rejectPendingDeploy } = await import('@/lib/stacks/stack-service');
    return rejectPendingDeploy(data.deployId);
  });

/**
 * Scan for drift between the repo manifest and each Docker host's agent filesystem.
 * Operator-gated: the report names stacks read off host filesystems that the repo
 * does not track, which no other read path exposes.
 */
export const scanDrift = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<StackDriftReport> => {
    requireRole('admin', 'operator')(context.user);
    const { scanStackDrift } = await import('@/lib/stacks/stack-service');
    return scanStackDrift();
  });

/**
 * Apply a resolution to one drifted stack.
 */
export const resolveDrift = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(resolveDriftSchema)
  .handler(async ({ data, context }): Promise<StackDriftResolutionResult> => {
    requireRole('admin', 'operator')(context.user);
    const { resolveStackDriftItem } = await import('@/lib/stacks/stack-service');
    return resolveStackDriftItem(data);
  });

/**
 * Get deploy history for a stack.
 */
export const getDeployHistory = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(getDeployHistorySchema)
  .handler(async ({ data }): Promise<StackDeployRecord[]> => {
    const { getStackDeployHistory } = await import('@/lib/stacks/stack-service');
    return getStackDeployHistory(data.stackName, data.limit);
  });

/**
 * Save compose file content (creates a git commit).
 * After a successful commit, ensures DB secret entries exist for all detected variables.
 * Returns warnings if the secrets store is unavailable; the save itself still succeeds.
 */
export const saveComposeFile = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(saveComposeFileSchema)
  .handler(async ({ data, context }): Promise<{ commitSha: string; warnings?: string[] }> => {
    requireRole('admin', 'operator')(context.user);
    const { saveStackComposeFile } = await import('@/lib/stacks/stack-service');
    const { extractVariableNames } = await import('@/lib/stacks/stack-mappers');
    const result = await saveStackComposeFile(data.stackName, data.content);

    const variableNames = extractVariableNames(data.content);
    if (variableNames.length > 0) {
      try {
        const { databaseConnectionManager } = await import('@/lib/clients/database-client');
        const { loadDatabaseConfig } = await import('@/lib/config/database-config');
        const { StackSecretsRepository } = await import('@/lib/database/repositories/stack-secrets-repository');
        const { loadMasterKeyring } = await import('@/lib/crypto/master-key');
        const dbClient = await databaseConnectionManager.getClient(loadDatabaseConfig());
        const keyring = await loadMasterKeyring();
        const repo = new StackSecretsRepository(dbClient.getPool(), keyring);
        await Promise.all(variableNames.map((name) => repo.ensureExists(data.stackName, name)));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('ensureVariablesExist failed (non-fatal):', msg);
        return { ...result, warnings: ['Could not pre-create stack variables.'] };
      }
    }

    return result;
  });

const SAFE_PATH_SEGMENT_PATTERN = /^[a-zA-Z0-9_-]+$/;
const safePathSegment = z.string().min(1).regex(SAFE_PATH_SEGMENT_PATTERN, 'Must contain only letters, numbers, hyphens, and underscores');

const stackVariableValuesSchema = z.object({
  stackName: safePathSegment,
});

/**
 * Fetch every variable name and decrypted value for a stack in one call.
 * Backs the secrets tab, which loads all values up front for a single reveal
 * toggle and one "save all" action.
 */
export const getStackVariableValues = createServerFn({ method: 'GET' })
  .middleware([authMiddleware, stackSecretsMiddleware])
  .inputValidator(stackVariableValuesSchema)
  .handler(async ({ context, data }): Promise<Record<string, string>> => {
    requireRole('admin', 'operator')(context.user);
    const { StackSecretsRepository } = await import('@/lib/database/repositories/stack-secrets-repository');
    const repo = new StackSecretsRepository(context.pool, context.keyring);
    return repo.getAll(data.stackName);
  });

const setVariableValueSchema = z.object({
  stackName: safePathSegment,
  variableName: safePathSegment,
  value: z.string(),
});

/**
 * Create or update a secret value.
 */
export const setVariableValue = createServerFn({ method: 'POST' })
  .middleware([authMiddleware, stackSecretsMiddleware])
  .inputValidator(setVariableValueSchema)
  .handler(async ({ context, data }): Promise<void> => {
    requireRole('admin', 'operator')(context.user);
    const { StackSecretsRepository } = await import('@/lib/database/repositories/stack-secrets-repository');
    const repo = new StackSecretsRepository(context.pool, context.keyring);
    await repo.set(data.stackName, data.variableName, data.value);
  });

const deleteVariableSchema = z.object({
  stackName: safePathSegment,
  variableName: safePathSegment,
});

/**
 * Delete a secret for a given stack variable.
 */
export const deleteVariable = createServerFn({ method: 'POST' })
  .middleware([authMiddleware, stackSecretsMiddleware])
  .inputValidator(deleteVariableSchema)
  .handler(async ({ context, data }): Promise<void> => {
    requireRole('admin', 'operator')(context.user);
    const { StackSecretsRepository } = await import('@/lib/database/repositories/stack-secrets-repository');
    const repo = new StackSecretsRepository(context.pool, context.keyring);
    await repo.delete(data.stackName, data.variableName);
  });

/**
 * List managed host names for use in the create stack dialog host selector.
 */
export const listManagedHostNames = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async (): Promise<string[]> => {
    const { getManagedHostNames } = await import('@/lib/stacks/stack-service');
    return getManagedHostNames();
  });

const createStackSchema = z.object({
  stackName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
  host: z.string().min(1),
  autoDeploy: z.boolean(),
});

/**
 * Create a new stack: adds an empty compose file and updates the manifest in one commit.
 */
export const createStack = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(createStackSchema)
  .handler(async ({ data, context }): Promise<{ commitSha: string }> => {
    requireRole('admin', 'operator')(context.user);
    const { createStackInRepo } = await import('@/lib/stacks/stack-service');
    return createStackInRepo(data.stackName, data.host, data.autoDeploy);
  });

const deleteStackSchema = z.object({
  stackName: z.string().min(1),
  teardown: z.boolean(),
});

/**
 * Delete a stack from the git repo. If `teardown` is true, dispatches a
 * teardown via the deploy pipeline and awaits its completion; the pipeline's
 * postSuccess hook removes the manifest entry once the agent reports success.
 * If `teardown` is false, removes the stack from the manifest synchronously.
 */
export const deleteStack = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(deleteStackSchema)
  .handler(async ({ data, context }): Promise<
    | { status: 'removed'; commitSha: string }
    | { status: 'teardown-pending'; deployId: number }
  > => {
    requireRole('admin', 'operator')(context.user);
    const { deleteStackFromRepo } = await import('@/lib/stacks/stack-service');
    return deleteStackFromRepo(data.stackName, data.teardown);
  });

const updateStackSettingsSchema = z.object({
  stackName: z.string().min(1),
  host: z.string().min(1),
  autoDeploy: z.boolean(),
});

/**
 * Update stack settings (host assignment and deploy mode) by writing to manifest.yaml.
 */
export const updateStackSettings = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(updateStackSettingsSchema)
  .handler(async ({ data, context }): Promise<{ commitSha: string }> => {
    requireRole('admin', 'operator')(context.user);
    const { loadGitConfig } = await import('@/lib/config/git-config');
    const { updateManifest } = await import('@/lib/git/editor-operations');
    const config = loadGitConfig();
    return updateManifest(config.repoPath, {
      stackName: data.stackName,
      host: data.host,
      autoDeploy: data.autoDeploy,
      author: { name: 'homelab-manager', email: 'homelab-manager@localhost' },
    });
  });


const ensureVariablesExistSchema = z.object({
  stackName: safePathSegment,
  variableNames: z.array(safePathSegment),
});

/**
 * Ensure all given variable names have an entry in the secrets store.
 * Variables that already exist are left untouched; missing ones are created with an empty value.
 */
export const ensureVariablesExist = createServerFn({ method: 'POST' })
  .middleware([authMiddleware, stackSecretsMiddleware])
  .inputValidator(ensureVariablesExistSchema)
  .handler(async ({ context, data }): Promise<void> => {
    requireRole('admin', 'operator')(context.user);
    const { StackSecretsRepository } = await import('@/lib/database/repositories/stack-secrets-repository');
    const repo = new StackSecretsRepository(context.pool, context.keyring);
    await Promise.all(
      data.variableNames.map((name) => repo.ensureExists(data.stackName, name)),
    );
  });

/**
 * Directly start, stop, or restart a stack or individual service on its agent host.
 * Bypasses the deploy pipeline; no deploy history record is created.
 */
export const controlStack = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(controlStackSchema)
  .handler(async ({ data, context }): Promise<void> => {
    requireRole('admin', 'operator')(context.user);
    const { controlStackForHost } = await import('@/lib/stacks/stack-service');
    const req: StackControlRequest = data.scope === 'service'
      ? { stack: data.stack, scope: 'service', service: data.service }
      : { stack: data.stack, scope: 'stack' };
    await controlStackForHost(data.host, data.action, req);
  });
