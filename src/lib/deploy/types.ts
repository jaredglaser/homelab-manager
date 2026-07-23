export type DeployAction = 'deploy' | 'teardown' | 'update';

export type DeployStatus =
  | 'pending'
  | 'in_progress'
  | 'succeeded'
  | 'failed'
  | 'no_change';

export type DeployTrigger = 'git_push' | 'ui' | 'manual_rollback';

/**
 * Action to run inside the pipeline after a deploy reaches a terminal-success
 * state (`succeeded` or `no_change`). Currently only `removeFromManifest` is
 * supported, used by async teardown to delete the stack entry from the git
 * manifest once the agent reports teardown complete.
 */
export type DeployPostSuccess = 'removeFromManifest';

interface BaseDeployRequest {
  stack: string;
  host: string;
  commitSha: string;
  trigger: DeployTrigger;
  autoApproved: boolean;
  /** Optional post-success hook executed by the pipeline. */
  postSuccess?: DeployPostSuccess;
}

export interface DeployActionRequest extends BaseDeployRequest {
  action: 'deploy';
  composeContent: string;
  envContent: string;
  forceRecreate?: boolean;
}

export interface TeardownRequest extends BaseDeployRequest {
  action: 'teardown';
}

export interface UpdateRequest extends BaseDeployRequest {
  action: 'update';
  composeContent: string;
  envContent: string;
}

export type DeployRequest = DeployActionRequest | TeardownRequest | UpdateRequest;

export interface DeployRecord {
  id: number;
  stack: string;
  host: string;
  commitSha: string;
  composeHash: string;
  envHash: string;
  status: DeployStatus;
  trigger: DeployTrigger;
  action: DeployAction;
  forceRecreate: boolean;
  logs: string | null;
  createdAt: Date;
  postSuccess: DeployPostSuccess | null;
}

export type {
  ManagedHost,
  HostCapabilities,
  HostStatus as ManagedHostStatus,
} from '@/lib/database/repositories/host-repository';

export interface ManifestEntry {
  host: string;
  autoDeploy: boolean;
}

export interface Manifest {
  stacks: Record<string, ManifestEntry>;
}

/** Secret resolution contract for the deploy pipeline executor. */
export interface SecretResolver {
  resolve(stack: string, variables: string[]): Promise<Record<string, string>>;
}

export interface AgentDeployPayload {
  stack: string;
  composeContent: string;
  envContent: string;
  action: DeployAction;
  forceRecreate?: boolean;
}

export interface AgentUpdatePayload {
  stack: string;
  composeContent: string;
  envContent: string;
}

export interface AgentDeployResponse {
  success: boolean;
  logs: string;
}
