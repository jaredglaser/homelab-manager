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

/** Successful /health response (HTTP 200). */
export interface AgentHealthyResponse {
  status: 'healthy';
  agentVersion: string;
  docker: {
    version: string;
    apiVersion: string;
  };
}

export type AgentUnhealthyError = 'docker_unreachable' | 'auth_failed' | 'timeout';

/** Failed /health response (HTTP 503). */
export interface AgentUnhealthyResponse {
  status: 'unhealthy';
  agentVersion: string;
  error: AgentUnhealthyError;
  detail: string;
}

export type AgentHealthCheckResponse = AgentHealthyResponse | AgentUnhealthyResponse;
