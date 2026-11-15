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

/** The agent's JSON error shape wherever it reports a TLS failure: a human message plus the reason. */
export interface AgentErrorBody {
  error: string;
  code: TlsFailureCode;
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
