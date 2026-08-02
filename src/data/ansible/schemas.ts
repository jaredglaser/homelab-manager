import { z } from 'zod';

/** Bare filename only: the request names a playbook the repo ships, it never carries tasks. */
const playbookSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+\.ya?ml$/, 'Must be a bare .yml filename');

export const startAnsibleRunSchema = z.object({
  playbook: playbookSchema.default('host_baseline.yml'),
  hosts: z.array(z.string().min(1)).min(1, 'Select at least one host'),
  checkMode: z.boolean().default(false),
});

export const cancelAnsibleRunSchema = z.object({
  runId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
});

export const listAnsibleRunsSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
});
