import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { openBaoMiddleware } from '@/middleware/openbao-middleware';
import type { OpenBaoClient } from '@/lib/clients/openbao-client';
import { SAFE_PATH_SEGMENT_PATTERN } from '@/lib/constants/openbao';

/** Reusable pattern for safe path segments (stack names, secret keys) */
const safePathSegment = z.string().regex(
  SAFE_PATH_SEGMENT_PATTERN,
  'Must contain only letters, numbers, hyphens, and underscores',
);

const stackInput = z.object({ stack: safePathSegment });
const stackKeyInput = z.object({ stack: safePathSegment, key: safePathSegment });
const stackKeyValueInput = z.object({
  stack: safePathSegment,
  key: safePathSegment,
  value: z.string().min(1),
});

// --- Exported handler logic for testing ---

/** List secret names for a stack. Returns sorted names only, never values. */
export async function handleListStackSecrets(
  client: OpenBaoClient,
  data: z.infer<typeof stackInput>,
): Promise<string[]> {
  const keys = await client.listSecrets(data.stack);
  return [...keys].sort();
}

/** Get a single secret value. Throws if not found. */
export async function handleGetStackSecret(
  client: OpenBaoClient,
  data: z.infer<typeof stackKeyInput>,
): Promise<{ value: string }> {
  const value = await client.getSecret(data.stack, data.key);
  if (value === null) {
    throw new Error(`Secret not found: ${data.key}`);
  }
  return { value };
}

/** Set or update a secret value. */
export async function handleSetStackSecret(
  client: OpenBaoClient,
  data: z.infer<typeof stackKeyValueInput>,
): Promise<{ success: true }> {
  await client.setSecret(data.stack, data.key, data.value);
  return { success: true };
}

/** Delete a secret. */
export async function handleDeleteStackSecret(
  client: OpenBaoClient,
  data: z.infer<typeof stackKeyInput>,
): Promise<{ success: true }> {
  await client.deleteSecret(data.stack, data.key);
  return { success: true };
}

// --- Zod schemas exported for validation testing ---

export { safePathSegment, stackInput, stackKeyInput, stackKeyValueInput };

// --- Server functions wiring middleware + validation + handlers ---

/**
 * List secret names for a stack. Returns names only, never values.
 */
export const listStackSecrets = createServerFn({ method: 'GET' })
  .middleware([openBaoMiddleware])
  .inputValidator((data: unknown) => stackInput.parse(data))
  .handler(async ({ context, data }) => {
    return handleListStackSecrets(context.openBaoClient, data);
  });

/**
 * Get a single secret value (for reveal in UI).
 * Returns the value directly — the frontend should display it briefly and discard.
 */
export const getStackSecret = createServerFn({ method: 'POST' })
  .middleware([openBaoMiddleware])
  .inputValidator((data: unknown) => stackKeyInput.parse(data))
  .handler(async ({ context, data }) => {
    return handleGetStackSecret(context.openBaoClient, data);
  });

/**
 * Set or update a secret value.
 */
export const setStackSecret = createServerFn({ method: 'POST' })
  .middleware([openBaoMiddleware])
  .inputValidator((data: unknown) => stackKeyValueInput.parse(data))
  .handler(async ({ context, data }) => {
    return handleSetStackSecret(context.openBaoClient, data);
  });

/**
 * Delete a secret.
 */
export const deleteStackSecret = createServerFn({ method: 'POST' })
  .middleware([openBaoMiddleware])
  .inputValidator((data: unknown) => stackKeyInput.parse(data))
  .handler(async ({ context, data }) => {
    return handleDeleteStackSecret(context.openBaoClient, data);
  });
