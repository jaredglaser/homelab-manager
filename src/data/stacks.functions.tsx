import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { StackSummary, StackDetail, StackDeployRecord } from '@/types/stacks';
import type { OpenBaoClient } from '@/lib/clients/openbao-client';
import { authMiddleware } from '@/middleware/auth-middleware';
import { requireRole } from '@/lib/auth/require-role';

/**
 * Get an initialized OpenBao client. Ensures the KV v2 secrets engine
 * is enabled on first use (idempotent singleton).
 */
async function getOpenBaoClient(): Promise<OpenBaoClient> {
  const { isOpenBaoConfigured, loadOpenBaoConfig } = await import('@/lib/config/openbao-config');
  if (!isOpenBaoConfigured()) throw new Error('OpenBao is not configured');
  const { OpenBaoClient: Client } = await import('@/lib/clients/openbao-client');
  const { initializeOpenBao } = await import('@/lib/services/openbao-init');
  const config = loadOpenBaoConfig();
  const client = new Client(config);
  await initializeOpenBao(client);
  return client;
}

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

const getStackDetailSchema = z.object({
  stackName: z.string().min(1),
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

const triggerDeploySchema = z.object({
  stack: z.string().min(1),
  host: z.string().min(1),
  action: z.enum(['deploy', 'teardown', 'restart']),
  commitSha: z.string().optional(),
  forceRecreate: z.boolean().optional(),
});

/**
 * Trigger a deploy, teardown, or restart for a stack.
 * Pass an optional commitSha to perform a rollback to that specific commit.
 */
export const triggerDeploy = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(triggerDeploySchema)
  .handler(async ({ data, context }): Promise<{ deployId: number }> => {
    requireRole('admin', 'operator')(context.user);
    const { triggerStackDeploy } = await import('@/lib/stacks/stack-service');
    return triggerStackDeploy(data);
  });

const getDeployHistorySchema = z.object({
  stackName: z.string().min(1),
  limit: z.number().min(1).max(100).optional().default(20),
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

const saveComposeFileSchema = z.object({
  stackName: z.string().min(1),
  content: z.string(),
});

/** Parse variable references from compose content (server-side utility, no React deps). */
function extractComposeVariables(content: string): string[] {
  const regex = /\$\{([a-zA-Z_]\w*)(?::-[^}]*)?\}/g;
  const vars = new Set<string>();
  let match: RegExpMatchArray | null;
  while ((match = regex.exec(content)) !== null) {
    vars.add(match[1]);
  }
  return Array.from(vars).sort((a, b) => a.localeCompare(b));
}

/**
 * Save compose file content (creates a git commit).
 * After a successful commit, ensures OpenBao entries exist for all detected variables.
 * Returns warnings if OpenBao is unavailable — the save itself still succeeds.
 */
export const saveComposeFile = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(saveComposeFileSchema)
  .handler(async ({ data, context }): Promise<{ commitSha: string; warnings?: string[] }> => {
    requireRole('admin', 'operator')(context.user);
    const { saveStackComposeFile } = await import('@/lib/stacks/stack-service');
    const result = await saveStackComposeFile(data.stackName, data.content);

    const variableNames = extractComposeVariables(data.content);
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

const updateStackIconSchema = z.object({
  stackName: z.string().min(1),
  iconSlug: z.string().min(1),
});

/**
 * Update stack icon.
 */
export const updateStackIcon = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(updateStackIconSchema)
  .handler(async ({ data, context }): Promise<void> => {
    requireRole('admin', 'operator')(context.user);
    const { updateStackIconSlug } = await import('@/lib/stacks/stack-service');
    return updateStackIconSlug(data.stackName, data.iconSlug);
  });

const stackVariablesSchema = z.object({
  stackName: z.string().min(1),
});

/**
 * List all variable names stored in OpenBao for a stack.
 */
export const getStackVariables = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .inputValidator(stackVariablesSchema)
  .handler(async ({ data }): Promise<string[]> => {
    const client = await getOpenBaoClient();
    return client.listSecrets(data.stackName);
  });

const getVariableValueSchema = z.object({
  stackName: z.string().min(1),
  variableName: z.string().min(1),
});

/**
 * Fetch a single secret value from OpenBao. Returns null if the key does not exist.
 */
export const getVariableValue = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .inputValidator(getVariableValueSchema)
  .handler(async ({ data }): Promise<string | null> => {
    const client = await getOpenBaoClient();
    return client.getSecret(data.stackName, data.variableName);
  });

const setVariableValueSchema = z.object({
  stackName: z.string().min(1),
  variableName: z.string().min(1),
  value: z.string(),
});

/**
 * Create or update a secret value in OpenBao.
 */
export const setVariableValue = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(setVariableValueSchema)
  .handler(async ({ data, context }): Promise<void> => {
    requireRole('admin', 'operator')(context.user);
    const client = await getOpenBaoClient();
    await client.setSecret(data.stackName, data.variableName, data.value);
  });

const deleteVariableSchema = z.object({
  stackName: z.string().min(1),
  variableName: z.string().min(1),
});

/**
 * Delete a secret from OpenBao for a given stack variable.
 */
export const deleteVariable = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(deleteVariableSchema)
  .handler(async ({ data, context }): Promise<void> => {
    requireRole('admin', 'operator')(context.user);
    const client = await getOpenBaoClient();
    await client.deleteSecret(data.stackName, data.variableName);
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
  stackName: z.string(),
  teardown: z.boolean(),
});

/**
 * Delete a stack from the git repo, optionally tearing down containers first.
 */
export const deleteStack = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(deleteStackSchema)
  .handler(async ({ data, context }): Promise<{ commitSha: string }> => {
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
    if (!config.enabled || !config.repoPath) throw new Error('Git management is not enabled');
    return updateManifest(config.repoPath, {
      stackName: data.stackName,
      host: data.host,
      autoDeploy: data.autoDeploy,
      author: { name: 'homelab-manager', email: 'homelab-manager@localhost' },
    });
  });

const ensureVariablesExistSchema = z.object({
  stackName: z.string().min(1),
  variableNames: z.array(z.string().min(1)),
});

/**
 * Ensure all given variable names have an entry in OpenBao.
 * Variables that already exist are left untouched; missing ones are created with an empty value.
 */
export const ensureVariablesExist = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .inputValidator(ensureVariablesExistSchema)
  .handler(async ({ data, context }): Promise<void> => {
    requireRole('admin', 'operator')(context.user);
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
