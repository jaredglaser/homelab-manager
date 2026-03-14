/** Deploy status as defined in the design spec */
export type DeployStatus = 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'no_change';

/** Sync status for a stack (derived from comparing current vs last deployed commit) */
export type SyncStatus = 'in-sync' | 'pending' | 'failed' | 'unknown';

/** Deploy mode from manifest */
export type DeployMode = 'auto' | 'manual';

/** Trigger source for a deploy */
export type DeployTrigger = 'git_push' | 'ui' | 'manual_rollback';

/** Summary of a stack as shown in the list view */
export interface StackSummary {
  name: string;
  host: string;
  syncStatus: SyncStatus;
  deployMode: DeployMode;
  lastDeployAt: string | null;
  lastDeployStatus: DeployStatus | null;
  containerCount: number;
  icon: string | null;
}

/** Full stack detail shown in expanded view */
export interface StackDetail {
  name: string;
  host: string;
  syncStatus: SyncStatus;
  deployMode: DeployMode;
  composeContent: string;
  lastDeployCommitSha: string | null;
  currentCommitSha: string;
  variables: string[];
  icon: string | null;
}

/** A single deploy history record */
export interface DeployRecord {
  id: number;
  stack: string;
  host: string;
  commitSha: string;
  envHash: string;
  status: DeployStatus;
  trigger: DeployTrigger;
  logs: string | null;
  createdAt: string;
}

/** Request to trigger a deploy from the UI */
export interface UIDeployRequest {
  stack: string;
  host: string;
  action: 'deploy' | 'teardown' | 'restart';
}
