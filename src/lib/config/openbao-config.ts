import { z } from 'zod';

const OpenBaoConfigSchema = z.object({
  url: z
    .string()
    .min(1)
    .url()
    .transform((val) => val.replace(/\/+$/, '')),
  token: z.string().min(1),
});

export type OpenBaoConfig = z.infer<typeof OpenBaoConfigSchema>;

/**
 * Load OpenBao configuration from environment variables
 *
 * Required env vars:
 *   OPENBAO_URL - OpenBao server URL (e.g., http://openbao:8200)
 *   OPENBAO_TOKEN - Authentication token
 *
 * @returns Validated OpenBao configuration
 * @throws {z.ZodError} If configuration is invalid
 */
export function loadOpenBaoConfig(): OpenBaoConfig {
  return OpenBaoConfigSchema.parse({
    url: process.env.OPENBAO_URL,
    token: process.env.OPENBAO_TOKEN,
  });
}

/**
 * Check if OpenBao configuration is available (both OPENBAO_URL and OPENBAO_TOKEN set)
 */
export function isOpenBaoConfigured(): boolean {
  return !!process.env.OPENBAO_URL && !!process.env.OPENBAO_TOKEN;
}
