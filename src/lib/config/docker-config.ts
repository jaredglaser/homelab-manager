import { z } from 'zod';

const DockerHostConfigSchema = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  name: z.string(),
  protocol: z.enum(['http', 'https']).default('http'),
});

export type DockerHostConfig = z.infer<typeof DockerHostConfigSchema>;

const DockerConfigSchema = z.object({
  hosts: z.array(DockerHostConfigSchema),
});

export type DockerConfig = z.infer<typeof DockerConfigSchema>;

/**
 * Load Docker hosts configuration from environment variables
 * Supports multiple hosts via DOCKER_HOST_N, DOCKER_HOST_PORT_N, DOCKER_HOST_NAME_N pattern
 *
 * @returns Validated Docker configuration with array of hosts
 * @throws {z.ZodError} If configuration is invalid
 */
export function loadDockerConfig(): DockerConfig {
  const hosts: DockerHostConfig[] = [];

  // Check up to 10 hosts (or use explicit count if provided)
  const maxHosts = process.env.DOCKER_HOST_COUNT
    ? parseInt(process.env.DOCKER_HOST_COUNT, 10)
    : 10;

  for (let i = 1; i <= maxHosts; i++) {
    const host = process.env[`DOCKER_HOST_${i}`];

    // Stop at first missing host if count not explicit
    if (!host) {
      if (process.env.DOCKER_HOST_COUNT) continue;
      else break;
    }

    hosts.push({
      host,
      port: parseInt(process.env[`DOCKER_HOST_PORT_${i}`] || '2375', 10),
      name: process.env[`DOCKER_HOST_NAME_${i}`] || host,
      protocol: (process.env[`DOCKER_HOST_PROTOCOL_${i}`] as 'http' | 'https') || 'http',
    });
  }

  return DockerConfigSchema.parse({ hosts });
}
