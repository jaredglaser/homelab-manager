export type DeployAction = 'deploy' | 'teardown' | 'restart';

export type DeployStatus =
  | 'pending'
  | 'in_progress'
  | 'succeeded'
  | 'failed'
  | 'no_change';

export type DeployTrigger = 'git_push' | 'ui' | 'manual_rollback';

interface BaseDeployRequest {
  stack: string;
  host: string;
  commitSha: string;
  trigger: DeployTrigger;
  autoApproved: boolean;
}

export interface DeployActionRequest extends BaseDeployRequest {
  action: 'deploy';
  composeContent: string;
  envContent: string;
}

export interface TeardownRequest extends BaseDeployRequest {
  action: 'teardown';
}

export interface RestartRequest extends BaseDeployRequest {
  action: 'restart';
}

export type DeployRequest = DeployActionRequest | TeardownRequest | RestartRequest;

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

// Re-export from canonical location to avoid duplication
import type { HostStatus } from '@/lib/database/repositories/host-repository';
export type { HostStatus as ManagedHostStatus } from '@/lib/database/repositories/host-repository';
type ManagedHostStatus = HostStatus;

export interface ManagedHost {
  id: number;
  name: string;
  agentUrl: string;
  socketProxyUrl: string;
  agentVersion: string | null;
  status: ManagedHostStatus;
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
