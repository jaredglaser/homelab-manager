import { createMiddleware } from '@tanstack/react-start';
import { sshConnectionManager } from '../lib/clients/ssh-client';
import type { SSHConnectionConfig } from '../lib/streaming/types';

/**
 * SSH middleware factory
 * Creates middleware that injects an SSH client into the context
 */
export function createSSHMiddleware(config: SSHConnectionConfig) {
  return createMiddleware().server(async ({ next }) => {
    const sshClient = await sshConnectionManager.getClient(config);
    return next({ context: { ssh: sshClient } });
  });
}

/**
 * Create SSH middleware from environment variables
 * Matches the pattern used in docker.functions.tsx
 *
 * Environment variables expected:
 * - {envPrefix}_HOST - SSH hostname (required)
 * - {envPrefix}_PORT - SSH port (default: 22)
 * - {envPrefix}_USER - SSH username (default: root)
 * - {envPrefix}_KEY_PATH - Path to private key (required for privateKey auth)
 * - {envPrefix}_KEY_PASSPHRASE - Passphrase for encrypted keys (optional)
 * - {envPrefix}_PASSWORD - Password for password auth (alternative to key)
 *
 * @param envPrefix - Prefix for environment variables (e.g., 'ZFS_SSH')
 */
export function createSSHMiddlewareFromEnv(envPrefix: string) {
  const host = process.env[`${envPrefix}_HOST`];
  const port = parseInt(process.env[`${envPrefix}_PORT`] || '22');
  const username = process.env[`${envPrefix}_USER`] || 'root';
  const keyPath = process.env[`${envPrefix}_KEY_PATH`];
  const passphrase = process.env[`${envPrefix}_KEY_PASSPHRASE`];
  const password = process.env[`${envPrefix}_PASSWORD`];

  if (!host) {
    throw new Error(`SSH middleware requires ${envPrefix}_HOST environment variable`);
  }

  const config: SSHConnectionConfig = {
    id: `ssh-${envPrefix}`,
    type: 'ssh',
    host,
    port,
    auth: {
      type: keyPath ? 'privateKey' : 'password',
      username,
      ...(keyPath && { privateKeyPath: keyPath }),
      ...(passphrase && { passphrase }),
      ...(password && { password }),
    },
  };

  // Validate auth configuration
  if (config.auth.type === 'privateKey' && !config.auth.privateKeyPath) {
    throw new Error(`SSH middleware requires ${envPrefix}_KEY_PATH for private key authentication`);
  }

  if (config.auth.type === 'password' && !config.auth.password) {
    throw new Error(`SSH middleware requires ${envPrefix}_PASSWORD for password authentication`);
  }

  return createSSHMiddleware(config);
}

/**
 * ZFS SSH middleware with lazy initialization
 * Only creates the SSH client when actually invoked on the server
 */
export const zfsSSHMiddleware = createMiddleware().server(async ({ next }) => {
  // Lazy initialization - create SSH client on demand within server context
  const sshClient = await sshConnectionManager.getClient({
    id: 'ssh-ZFS_SSH',
    type: 'ssh',
    host: process.env.ZFS_SSH_HOST!,
    port: parseInt(process.env.ZFS_SSH_PORT || '22'),
    auth: {
      type: process.env.ZFS_SSH_KEY_PATH ? 'privateKey' : 'password',
      username: process.env.ZFS_SSH_USER || 'root',
      ...(process.env.ZFS_SSH_KEY_PATH && { privateKeyPath: process.env.ZFS_SSH_KEY_PATH }),
      ...(process.env.ZFS_SSH_KEY_PASSPHRASE && { passphrase: process.env.ZFS_SSH_KEY_PASSPHRASE }),
      ...(process.env.ZFS_SSH_PASSWORD && { password: process.env.ZFS_SSH_PASSWORD }),
    },
  });

  return next({ context: { ssh: sshClient } });
});
