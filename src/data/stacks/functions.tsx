import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { StackSummary, StackDetail, StackDeployRecord } from '@/types/stacks';
import type { OpenBaoClient } from '@/lib/clients/openbao-client';
import {
  getStackDetailSchema,
  triggerDeploySchema,
  getDeployHistorySchema,
  saveComposeFileSchema,
  updateStackIconSchema,
  resumeDeploySchema,
  rejectDeploySchema,
} from '@/data/stacks/schemas';

/**
 * Lazy wrapper around the shared OpenBao client factory. The factory owns
 * the single module-scoped cache used by both this file and openBaoMiddleware,
 * so invalidating or initializing the client in one place is reflected in the
 * other. Kept as a dynamic import so nothing from the factory's transitive
 * dependency graph can leak into the client bundle via this barrel file.
 */
async function getOpenBaoClient(): Promise<OpenBaoClient> {
  const { getOpenBaoClient: factory } = await import(
    '@/lib/clients/openbao-client-factory'
  );
  return factory();
}

/**
 * List all stacks from the manifest with their current sync status.
 * Reads the manifest via isomorphic-git, cross-references deploy_history for status.
 */
export const listStacks = createServerFn()
  .handler(async (): Promise<StackSummary[]> => {
    const { getStackSummaries } = await import('@/lib/stacks/stack-service');
    return getStackSummaries();
  });

/**
 * Get full detail for a single stack, including compose file content and variables.
 */
export const getStackDetail = createServerFn()
  .inputValidator(getStackDetailSchema)
  .handler(async ({ data }): Promise<StackDetail | null> => {
    const { getStackDetailByName } = await import('@/lib/stacks/stack-service');
    return getStackDetailByName(data.stackName);
  });



/**
 * Trigger a deploy, teardown, or restart for a stack.
 * Pass an optional commitSha to perform a rollback to that specific commit.
 */
export const triggerDeploy = createServerFn()
  .inputValidator(triggerDeploySchema)
  .handler(async ({ data }): Promise<{ deployId: number }> => {
    const { triggerStackDeploy } = await import('@/lib/stacks/stack-service');
    return triggerStackDeploy(data);
  });

/**
 * Approve a pending deploy — runs it through the pipeline's resumePending path.
 */
export const resumeDeploy = createServerFn({ method: 'POST' })
  .inputValidator(resumeDeploySchema)
  .handler(async ({ data }): Promise<{ deployId: number }> => {
    const { resumePendingDeploy } = await import('@/lib/stacks/stack-service');
    return resumePendingDeploy(data.deployId);
  });

/**
 * Reject a pending deploy — marks it failed with a "Manually rejected" log.
 */
export const rejectDeploy = createServerFn({ method: 'POST' })
  .inputValidator(rejectDeploySchema)
  .handler(async ({ data }): Promise<{ deployId: number }> => {
    const { rejectPendingDeploy } = await import('@/lib/stacks/stack-service');
    return rejectPendingDeploy(data.deployId);
  });

/**
 * Get deploy history for a stack.
 */
export const getDeployHistory = createServerFn()
  .inputValidator(getDeployHistorySchema)
  .handler(async ({ data }): Promise<StackDeployRecord[]> => {
    const { getStackDeployHistory } = await import('@/lib/stacks/stack-service');
    return getStackDeployHistory(data.stackName, data.limit);
  });

/**
 * Save compose file content (creates a git commit).
 * After a successful commit, ensures OpenBao entries exist for all detected variables.
 * Returns warnings if OpenBao is unavailable; the save itself still succeeds.
 */
export const saveComposeFile = createServerFn()
  .inputValidator(saveComposeFileSchema)
  .handler(async ({ data }): Promise<{ commitSha: string; warnings?: string[] }> => {
    const { saveStackComposeFile } = await import('@/lib/stacks/stack-service');
    const { extractVariableNames } = await import('@/lib/stacks/stack-mappers');
    const result = await saveStackComposeFile(data.stackName, data.content);

    const variableNames = extractVariableNames(data.content);
    if (variableNames.length > 0) {
      try {
        const client = await getOpenBaoClient();
        await Promise.all(
          variableNames.map(async (name) => {
            const existing = await client.getSecret(data.stackName, name);
            if (existing === null) {
              await client.setSecret(data.stackName, name, '');
            }
          }),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('OpenBao ensureVariablesExist failed (non-fatal):', msg);
        return { ...result, warnings: [`OpenBao unavailable: ${msg}`] };
      }
    }

    return result;
  });

/**
 * Update stack icon.
 */
export const updateStackIcon = createServerFn()
  .inputValidator(updateStackIconSchema)
  .handler(async ({ data }): Promise<void> => {
    const { updateStackIconSlug } = await import('@/lib/stacks/stack-service');
    return updateStackIconSlug(data.stackName, data.iconSlug);
  });

const SAFE_PATH_SEGMENT_PATTERN = /^[a-zA-Z0-9_-]+$/;
const safePathSegment = z.string().min(1).regex(SAFE_PATH_SEGMENT_PATTERN, 'Must contain only letters, numbers, hyphens, and underscores');

const stackVariablesSchema = z.object({
  stackName: safePathSegment,
});

/**
 * List all variable names stored in OpenBao for a stack.
 */
export const getStackVariables = createServerFn({ method: 'GET' })
  .inputValidator(stackVariablesSchema)
  .handler(async ({ data }): Promise<string[]> => {
    const client = await getOpenBaoClient();
    return client.listSecrets(data.stackName);
  });

const getVariableValueSchema = z.object({
  stackName: safePathSegment,
  variableName: safePathSegment,
});

/**
 * Fetch a single secret value from OpenBao. Returns null if the key does not exist.
 */
export const getVariableValue = createServerFn({ method: 'GET' })
  .inputValidator(getVariableValueSchema)
  .handler(async ({ data }): Promise<string | null> => {
    const client = await getOpenBaoClient();
    return client.getSecret(data.stackName, data.variableName);
  });

const setVariableValueSchema = z.object({
  stackName: safePathSegment,
  variableName: safePathSegment,
  value: z.string(),
});

/**
 * Create or update a secret value in OpenBao.
 */
export const setVariableValue = createServerFn({ method: 'POST' })
  .inputValidator(setVariableValueSchema)
  .handler(async ({ data }): Promise<void> => {
    const client = await getOpenBaoClient();
    await client.setSecret(data.stackName, data.variableName, data.value);
  });

const deleteVariableSchema = z.object({
  stackName: safePathSegment,
  variableName: safePathSegment,
});

/**
 * Delete a secret from OpenBao for a given stack variable.
 */
export const deleteVariable = createServerFn({ method: 'POST' })
  .inputValidator(deleteVariableSchema)
  .handler(async ({ data }): Promise<void> => {
    const client = await getOpenBaoClient();
    await client.deleteSecret(data.stackName, data.variableName);
  });

/**
 * List managed host names for use in the create stack dialog host selector.
 */
export const listManagedHostNames = createServerFn({ method: 'GET' })
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
  .inputValidator(createStackSchema)
  .handler(async ({ data }): Promise<{ commitSha: string }> => {
    const { createStackInRepo } = await import('@/lib/stacks/stack-service');
    return createStackInRepo(data.stackName, data.host, data.autoDeploy);
  });

const deleteStackSchema = z.object({
  stackName: z.string().min(1),
  teardown: z.boolean(),
});

/**
 * Delete a stack from the git repo. If `teardown` is true, queues an async
 * teardown via the deploy pipeline and returns immediately; the pipeline's
 * postSuccess hook removes the manifest entry once the agent reports success.
 * If `teardown` is false, removes the stack from the manifest synchronously.
 */
export const deleteStack = createServerFn({ method: 'POST' })
  .inputValidator(deleteStackSchema)
  .handler(async ({ data }): Promise<
    | { status: 'removed'; commitSha: string }
    | { status: 'teardown-pending'; deployId: number }
  > => {
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
  .inputValidator(updateStackSettingsSchema)
  .handler(async ({ data }): Promise<{ commitSha: string }> => {
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
 * Ensure all given variable names have an entry in OpenBao.
 * Variables that already exist are left untouched; missing ones are created with an empty value.
 */
export const ensureVariablesExist = createServerFn({ method: 'POST' })
  .inputValidator(ensureVariablesExistSchema)
  .handler(async ({ data }): Promise<void> => {
    const client = await getOpenBaoClient();
    await Promise.all(
      data.variableNames.map(async (name) => {
        const existing = await client.getSecret(data.stackName, name);
        if (existing === null) {
          await client.setSecret(data.stackName, name, '');
        }
      }),
    );
  });
