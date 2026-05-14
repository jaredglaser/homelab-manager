/**
 * Check if Docker stack management feature is enabled.
 * Gated behind DOCKER_MANAGEMENT_FEATURE_FLAG=true env var.
 */
export function isDockerManagementEnabled(): boolean {
  return process.env.DOCKER_MANAGEMENT_FEATURE_FLAG === 'true';
}

/**
 * Check if authentication is enabled (server-side only).
 * Auth state reaches the client through the getSession() server function.
 */
export function isAuthEnabled(): boolean {
  return process.env.AUTH_ENABLED === 'true';
}
