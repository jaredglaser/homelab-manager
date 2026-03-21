import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { StackSummary, StackDetail, StackDeployRecord } from '@/types/stacks';

/**
 * List all stacks from the manifest with their current sync status.
 * Reads the manifest via isomorphic-git, cross-references deploy_history for status.
 */
export const listStacks = createServerFn()
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

const getDeployHistorySchema = z.object({
  stackName: z.string().min(1),
  limit: z.number().min(1).max(100).optional().default(20),
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

const saveComposeFileSchema = z.object({
  stackName: z.string().min(1),
  content: z.string(),
});

/**
 * Save compose file content (creates a git commit).
 */
export const saveComposeFile = createServerFn()
  .inputValidator(saveComposeFileSchema)
  .handler(async ({ data }): Promise<{ commitSha: string }> => {
    const { saveStackComposeFile } = await import('@/lib/stacks/stack-service');
    return saveStackComposeFile(data.stackName, data.content);
  });

const updateStackIconSchema = z.object({
  stackName: z.string().min(1),
  iconSlug: z.string().min(1),
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
