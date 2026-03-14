export type DeployAction = 'deploy' | 'teardown' | 'restart';

export type DeployStatus =
  | 'pending'
  | 'in_progress'
  | 'succeeded'
  | 'failed'
  | 'no_change';

export type DeployTrigger = 'git_push' | 'ui' | 'manual_rollback';

export interface DeployRequest {
  stack: string;
  host: string;
  composeContent: string;
  commitSha: string;
  envContent: string;
  action: DeployAction;
  trigger: DeployTrigger;
  autoApproved: boolean;
}

export interface DeployRecord {
  id: number;
  stack: string;
  host: string;
  commitSha: string;
  composeHash: string;
  envHash: string;
  status: DeployStatus;
  trigger: DeployTrigger;
  logs: string | null;
  createdAt: Date;
}

export interface ManagedHost {
  id: number;
  name: string;
  agentUrl: string;
  agentTokenHash: string;
  socketProxyUrl: string;
  agentVersion: string | null;
  status: string;
  createdAt: Date;
}

export interface ManifestEntry {
  host: string;
  autoDeploy: boolean;
}

export interface Manifest {
  stacks: Record<string, ManifestEntry>;
}

/**
 * Secret resolver interface. The no-op implementation returns an empty record.
 * The OpenBao plan provides a real implementation.
 */
export interface SecretResolver {
  resolve(stack: string, variables: string[]): Promise<Record<string, string>>;
}

export interface AgentDeployPayload {
  stack: string;
  composeContent: string;
  envContent: string;
  action: DeployAction;
}

export interface AgentDeployResponse {
  success: boolean;
  logs: string;
}
