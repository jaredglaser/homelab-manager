/**
 * Shared API contract types for the homelab-manager agent.
 * The main app imports these to stay in sync with the agent's response shapes.
 * A body the manager parses at runtime is declared as a zod schema with its type inferred, so the
 * check the manager runs and the type the agent sends cannot drift apart.
 */

import { z } from 'zod';

/** Set on every response the agent sends. The manager treats a failure without it as an answer from something else. */
export const AGENT_IDENTITY_HEADER = 'X-Homelab-Agent';

/** The header's value: the agent wire protocol this agent speaks. Changes only on a breaking wire change, never with the release version, since unauthenticated responses carry it. */
export const AGENT_PROTOCOL_VERSION = 1;

/** Successful or failed result from /stacks/deploy, /stacks/teardown, /stacks/restart. */
export const zAgentStackResponse = z.object({
  status: z.enum(['success', 'failed']),
  stdout: z.string(),
  stderr: z.string(),
  /** Null when the process was killed and never reported an exit. */
  exitCode: z.number().nullable().optional(),
});
export type AgentStackResponse = z.infer<typeof zAgentStackResponse>;

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
  'agent_not_answering',
  'unexpected_redirect',
] as const;
export type TlsFailureCode = (typeof TLS_FAILURE_CODES)[number];

const MANAGER_ONLY_TLS_CODES: ReadonlySet<string> = new Set(['agent_not_answering', 'unexpected_redirect']);

/** Narrows a code an agent sent. Excludes the codes only the manager raises. */
export function isTlsFailureCode(value: unknown): value is TlsFailureCode {
  return typeof value === 'string' && !MANAGER_ONLY_TLS_CODES.has(value) && (TLS_FAILURE_CODES as readonly string[]).includes(value);
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
] as const;
export const zAgentRouteFailureCode = z.enum(AGENT_ROUTE_FAILURE_CODES);
export type AgentRouteFailureCode = z.infer<typeof zAgentRouteFailureCode>;

export function isAgentRouteFailureCode(value: unknown): value is AgentRouteFailureCode {
  return typeof value === 'string' && (AGENT_ROUTE_FAILURE_CODES as readonly string[]).includes(value);
}

/** The codes POST /agent/update refuses with. The Hosts page branches on this set, so a code from another route stays generic there. */
export const AGENT_UPDATE_FAILURE_CODES = [
  'update_docker_unavailable',
  'update_request_invalid',
  'update_target_not_pinned',
  'update_target_repo_mismatch',
  'update_in_progress',
  'update_start_failed',
] as const satisfies readonly AgentRouteFailureCode[];
export type AgentUpdateFailureCode = (typeof AGENT_UPDATE_FAILURE_CODES)[number];

export function isAgentUpdateFailureCode(value: unknown): value is AgentUpdateFailureCode {
  return typeof value === 'string' && (AGENT_UPDATE_FAILURE_CODES as readonly string[]).includes(value);
}

/** The agent's JSON error shape wherever it reports a TLS failure: a human message plus the reason. */
export interface AgentErrorBody {
  error: string;
  code: TlsFailureCode;
}

/** The agent's JSON error body for a route failure. `detail` carries upstream text a route did not fold into `error`. */
export const zAgentRouteErrorBody = z.object({
  error: z.string(),
  code: zAgentRouteFailureCode,
  detail: z.string().optional(),
});
export type AgentRouteErrorBody = z.infer<typeof zAgentRouteErrorBody>;

/**
 * How the manager reads an error body. An agent older or newer than the manager can send no code or one
 * this manager does not know, and that has to degrade to generic copy instead of rejecting the message.
 */
export const zAgentRouteErrorBodyFromAnyAgent = zAgentRouteErrorBody.extend({
  code: zAgentRouteFailureCode.optional().catch(undefined),
});

export interface AgentDockerCapability {
  available: boolean;
  version?: string;
  apiVersion?: string;
}

/** Detail response from the authenticated /info endpoint (HTTP 200 when healthy, 503 when unhealthy). */
export interface AgentInfoResponse {
  status: 'healthy' | 'unhealthy';
  agentVersion: string;
  // Absent on agents predating image reporting; null means the agent looked and could not tell.
  agentImage?: string | null;
  agentImageTag?: string | null;
  // Absent on agents predating digest reporting. Null means the agent could not tell.
  agentImageDigest?: string | null;
  capabilities: {
    docker: AgentDockerCapability;
  };
}
