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
  // Optional because agents released before image reporting omit both fields; a
  // present-but-null value means the agent looked and could not tell.
  agentImage?: string | null;
  agentImageTag?: string | null;
  capabilities: {
    docker: AgentDockerCapability;
    zfs: AgentZfsCapability;
  };
}
