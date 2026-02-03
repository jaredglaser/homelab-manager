import { createMiddleware } from '@tanstack/react-start';
import { dockerConnectionManager } from '../lib/clients/docker-client';

/**
 * Docker middleware factory
 * Creates middleware that injects a Docker client into the context
 */
export function createDockerMiddleware(config?: {
  protocol?: string;
  host?: string;
  port?: number;
}) {
  return createMiddleware().server(async ({ next }) => {
    const dockerClient = await dockerConnectionManager.getClient({
      protocol: config?.protocol || 'http',
      host: config?.host || process.env.DOCKER_HOST_1 || 'localhost',
      port: config?.port || parseInt(process.env.DOCKER_HOST_PORT_1 || '2375'),
    });

    // Return Dockerode instance for backward compatibility
    return next({ context: { docker: dockerClient.getDocker() } });
  });
}

/**
 * Create Docker middleware from environment variables
 * Matches the pattern used in SSH middleware
 *
 * Environment variables expected:
 * - {envPrefix}_PROTOCOL - Docker protocol (default: http)
 * - {envPrefix}_HOST - Docker host (required)
 * - {envPrefix}_PORT - Docker port (default: 2375)
 *
 * @param envPrefix - Prefix for environment variables (e.g., 'DOCKER')
 */
export function createDockerMiddlewareFromEnv(envPrefix: string) {
  const protocol = process.env[`${envPrefix}_PROTOCOL`] || 'http';
  const host = process.env[`${envPrefix}_HOST`];
  const port = parseInt(process.env[`${envPrefix}_PORT`] || '2375');

  if (!host) {
    throw new Error(`Docker middleware requires ${envPrefix}_HOST environment variable`);
  }

  return createDockerMiddleware({
    protocol,
    host,
    port,
  });
}

// Default instance for backward compatibility
// Uses DOCKER_HOST_1 and DOCKER_HOST_PORT_1 environment variables
export const dockerMiddleware = createDockerMiddleware();
