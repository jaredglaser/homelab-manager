/**
 * Shared API contract types for the homelab-manager agent.
 * The main app imports these to stay in sync with the agent's response shapes.
 */

/** Successful or failed result from /stacks/deploy, /stacks/teardown, /stacks/restart. */
export interface AgentStackResponse {
  status: 'success' | 'failed';
  stdout: string;
  stderr: string;
  exitCode?: number;
}

export interface AgentStackInventoryEntry {
  name: string;
  hasComposeFile: true;
  composeHash: string;
}

export interface AgentStackInventoryError {
  name: string;
  message: string;
}

export interface AgentStackInventoryResponse {
  stacks: AgentStackInventoryEntry[];
  errors?: AgentStackInventoryError[];
}

export interface AgentStackComposeResponse {
  stack: string;
  composeContent: string;
  composeHash: string;
}

/**
 * Liveness response from the unauthenticated /health endpoint
 * (HTTP 200 when healthy, 503 when unhealthy). Status only:
 * version and capability detail require the authenticated /info endpoint.
 */
export interface AgentHealthCheckResponse {
  status: 'healthy' | 'unhealthy';
}

/**
 * Why a TLS enrollment call failed. The agent reports these in its JSON error bodies and the manager
 * raises the rest itself, so the UI maps a failure to its fix instead of matching on prose. Codes stay
 * granular because the code branches on them; the copy they map to may collapse several onto one
 * message when the operator's next step is the same.
 */
export const TLS_FAILURE_CODES = [
  // Reported by the agent over the wire.
  'not_configured_for_tls',
  'invalid_request',
  'challenge_expired',
  'signature_invalid',
  'challenge_reused',
  'key_generation_failed',
  'key_write_failed',
  'cert_sign_failed',
  'cert_write_failed',
  'restricted_plain_http',
  'internal_error',
  // Raised by the manager, either before the agent is called or after it answers.
  'pin_missing',
  'cert_unverifiable',
  'agent_unreachable',
  'plaintext_confirmation_required',
  'no_cert_returned',
  'store_failed',
  'restart_unavailable',
  'poll_timeout',
  'no_keypair',
  'unexpected_agent_response',
] as const;
export type TlsFailureCode = (typeof TLS_FAILURE_CODES)[number];

/** Narrows a code an agent sent, so a code this manager does not know degrades instead of crashing. */
export function isTlsFailureCode(value: unknown): value is TlsFailureCode {
  return typeof value === 'string' && (TLS_FAILURE_CODES as readonly string[]).includes(value);
}

export const AGENT_ROUTE_FAILURE_CODES = [
  'invalid_json',
  'invalid_request_body',
  'invalid_stack_name',
  'invalid_service_name',
  'missing_stack_field',
  'missing_service_field',
  'invalid_scope',
  'invalid_stack_path',
  'stack_not_found',
  'compose_spawn_failed',
  'stack_write_failed',
  'missing_deploy_fields',
  'invalid_deploy_fields',
  'invalid_env_content',
  'invalid_force_recreate',
  'compose_too_large',
  'env_too_large',
  'stacks_dir_unreadable',
  'compose_read_failed',
  'update_docker_unavailable',
  'update_request_invalid',
  'update_target_not_pinned',
  'update_target_repo_mismatch',
  'update_in_progress',
  'update_start_failed',
  'container_not_found',
  'container_state_unchanged',
  'container_control_failed',
  'zfs_unavailable',
  'zfs_pool_list_failed',
] as const;
export type AgentRouteFailureCode = (typeof AGENT_ROUTE_FAILURE_CODES)[number];

/** The agent's JSON error shape wherever it reports a TLS failure: a human message plus the reason. */
export interface AgentErrorBody {
  error: string;
  code: TlsFailureCode;
}

export interface AgentRouteErrorBody {
  error: string;
  code: AgentRouteFailureCode;
}

export interface AgentDockerCapability {
  available: boolean;
  version?: string;
  apiVersion?: string;
}

export interface AgentZfsCapability {
  available: boolean;
  version?: string;
  tier?: number;
  permissions?: string[];
}

/** Detail response from the authenticated /info endpoint (HTTP 200 when healthy, 503 when unhealthy). */
export interface AgentInfoResponse {
  status: 'healthy' | 'unhealthy';
  agentVersion: string;
  // Absent on agents predating image reporting; null means the agent looked and could not tell.
  agentImage?: string | null;
  agentImageTag?: string | null;
  // Absent on agents predating digest reporting. Null covers ZFS-only hosts and "could not tell".
  agentImageDigest?: string | null;
  capabilities: {
    docker: AgentDockerCapability;
    zfs: AgentZfsCapability;
  };
}
