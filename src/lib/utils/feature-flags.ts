/**
 * Check if Docker management features are enabled.
 * Controlled by VITE_DOCKER_MANAGEMENT_FEATURE_FLAG env var.
 *
 * Note: The `VITE_` prefix is required for client-side access via `import.meta.env`.
 * Server-side code (e.g., worker, server functions) should use
 * `DOCKER_MANAGEMENT_FEATURE_FLAG` (without prefix) via `process.env`.
 */
export function isDockerManagementEnabled(): boolean {
  return import.meta.env.VITE_DOCKER_MANAGEMENT_FEATURE_FLAG === 'true';
}
