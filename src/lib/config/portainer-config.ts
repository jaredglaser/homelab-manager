import { z } from 'zod';

const PortainerConfigSchema = z.object({
  url: z.string(),
  token: z.string(),
  allowSelfSignedCerts: z.boolean(),
});

export type PortainerConfig = z.infer<typeof PortainerConfigSchema>;

/**
 * Load Portainer configuration from environment variables
 *
 * Required env vars:
 *   PORTAINER_URL - Portainer API URL (e.g., https://portainer.local:9443)
 *   PORTAINER_TOKEN - Portainer API access token
 *
 * Optional env vars:
 *   PORTAINER_ALLOW_SELF_SIGNED - Allow self-signed certs (default: true)
 *
 * @returns Validated Portainer configuration
 * @throws {z.ZodError} If configuration is invalid
 */
export function loadPortainerConfig(): PortainerConfig {
  const config = {
    url: process.env.PORTAINER_URL || '',
    token: process.env.PORTAINER_TOKEN || '',
    allowSelfSignedCerts: process.env.PORTAINER_ALLOW_SELF_SIGNED !== 'false',
  };

  return PortainerConfigSchema.parse(config);
}

/**
 * Check if Portainer configuration is available (env vars set)
 */
export function isPortainerConfigured(): boolean {
  return !!(process.env.PORTAINER_URL && process.env.PORTAINER_TOKEN);
}
