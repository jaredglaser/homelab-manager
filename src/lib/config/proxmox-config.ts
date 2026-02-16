import { z } from 'zod';

const ProxmoxConfigSchema = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  tokenId: z.string(),
  tokenSecret: z.string(),
  allowSelfSignedCerts: z.boolean(),
});

export type ProxmoxConfig = z.infer<typeof ProxmoxConfigSchema>;

/**
 * Load Proxmox configuration from environment variables.
 * Uses API token authentication (recommended for automation/read-only).
 *
 * Required env vars:
 *   PROXMOX_HOST - Proxmox VE host address
 *   PROXMOX_TOKEN_ID - API token ID (e.g., "root@pam!mytoken")
 *   PROXMOX_TOKEN_SECRET - API token secret UUID
 *
 * Optional env vars:
 *   PROXMOX_PORT - API port (default: 8006)
 *   PROXMOX_ALLOW_SELF_SIGNED - Allow self-signed certs (default: true)
 */
export function loadProxmoxConfig(): ProxmoxConfig {
  const config = {
    host: process.env.PROXMOX_HOST || '',
    port: parseInt(process.env.PROXMOX_PORT || '8006', 10),
    tokenId: process.env.PROXMOX_TOKEN_ID || '',
    tokenSecret: process.env.PROXMOX_TOKEN_SECRET || '',
    allowSelfSignedCerts: process.env.PROXMOX_ALLOW_SELF_SIGNED !== 'false',
  };

  return ProxmoxConfigSchema.parse(config);
}
