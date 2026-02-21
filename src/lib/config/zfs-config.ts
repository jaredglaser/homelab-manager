import { z } from 'zod';

const ZFSHostConfigSchema = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  name: z.string(),
  username: z.string(),
  password: z.string().optional(),
  privateKeyPath: z.string().optional(),
  passphrase: z.string().optional(),
}).refine(
  (cfg) => cfg.password !== undefined || cfg.privateKeyPath !== undefined,
  { message: 'Either password or privateKeyPath must be provided' }
);
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  name: z.string(),
  username: z.string(),
  password: z.string().optional(),
  privateKeyPath: z.string().optional(),
  passphrase: z.string().optional(),
});

export type ZFSHostConfig = z.infer<typeof ZFSHostConfigSchema>;

const ZFSConfigSchema = z.object({
  hosts: z.array(ZFSHostConfigSchema),
});

export type ZFSConfig = z.infer<typeof ZFSConfigSchema>;

/**
 * Load ZFS hosts configuration from environment variables.
 *
 * Supports two formats:
 * 1. Legacy single-host: ZFS_SSH_HOST, ZFS_SSH_PORT, ZFS_SSH_USER, etc.
 * 2. Multi-host: ZFS_HOST_N, ZFS_HOST_PORT_N, ZFS_HOST_NAME_N, ZFS_HOST_USER_N, etc.
 *
 * If any numbered host (ZFS_HOST_1) is present, legacy vars are ignored.
 *
 * @returns Validated ZFS configuration with array of hosts
 * @throws {z.ZodError} If configuration is invalid
 */
export function loadZFSConfig(): ZFSConfig {
  const hosts: ZFSHostConfig[] = [];

  // Check for numbered hosts first
  const hasNumberedHosts = !!process.env.ZFS_HOST_1;

  if (hasNumberedHosts) {
    const maxHosts = process.env.ZFS_HOST_COUNT
      ? parseInt(process.env.ZFS_HOST_COUNT, 10)
      : 10;

    for (let i = 1; i <= maxHosts; i++) {
      const host = process.env[`ZFS_HOST_${i}`];

      if (!host) {
        if (process.env.ZFS_HOST_COUNT) continue;
        else break;
      }

      const username = process.env[`ZFS_HOST_USER_${i}`];
      const username = process.env[`ZFS_HOST_USER_${i}`];
      if (!username) {
        console.error(`[ZFSConfig] ZFS_HOST_${i} is set but ZFS_HOST_USER_${i} is missing — skipping host ${host}`);
        continue;
      }

      hosts.push({
        host,
        port: parseInt(process.env[`ZFS_HOST_PORT_${i}`] || '22', 10),
        name: process.env[`ZFS_HOST_NAME_${i}`] || host,
        username,
        ...(process.env[`ZFS_HOST_PASSWORD_${i}`] && { password: process.env[`ZFS_HOST_PASSWORD_${i}`] }),
        ...(process.env[`ZFS_HOST_KEY_PATH_${i}`] && { privateKeyPath: process.env[`ZFS_HOST_KEY_PATH_${i}`] }),
        ...(process.env[`ZFS_HOST_KEY_PASSPHRASE_${i}`] && { passphrase: process.env[`ZFS_HOST_KEY_PASSPHRASE_${i}`] }),
      });
    }
  } else {
    // Legacy single-host format
    const host = process.env.ZFS_SSH_HOST;
    const username = process.env.ZFS_SSH_USER;

    if (host && username) {
      hosts.push({
        host,
        port: parseInt(process.env.ZFS_SSH_PORT || '22', 10),
        name: process.env.ZFS_SSH_HOST_NAME || host,
        username,
        ...(process.env.ZFS_SSH_PASSWORD && { password: process.env.ZFS_SSH_PASSWORD }),
        ...(process.env.ZFS_SSH_KEY_PATH && { privateKeyPath: process.env.ZFS_SSH_KEY_PATH }),
        ...(process.env.ZFS_SSH_KEY_PASSPHRASE && { passphrase: process.env.ZFS_SSH_KEY_PASSPHRASE }),
      });
    }
  }

  return ZFSConfigSchema.parse({ hosts });
}
