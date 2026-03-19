/**
 * Client-side feature flag check for Docker management features.
 * Controlled by VITE_DOCKER_MANAGEMENT_FEATURE_FLAG env var.
 *
 * Note: The `VITE_` prefix is required for client-side access via `import.meta.env`.
 * Server-side code (e.g., worker, server functions) should use the server variant
 * in `@/lib/config/feature-flags` which reads `process.env.DOCKER_MANAGEMENT_FEATURE_FLAG`.
 */
export function isDockerManagementEnabledClient(): boolean {
  return import.meta.env.VITE_DOCKER_MANAGEMENT_FEATURE_FLAG === 'true';
}
