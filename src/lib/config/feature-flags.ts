/**
 * Check if Docker stack management feature is enabled.
 * Gated behind DOCKER_MANAGEMENT_FEATURE_FLAG=true env var.
 */
export function isDockerManagementEnabled(): boolean {
  return process.env.DOCKER_MANAGEMENT_FEATURE_FLAG === 'true';
}
