// Re-export canonical types from deploy layer to avoid duplication (Issue 12)
export type { DeployStatus, DeployTrigger } from '@/lib/deploy/types';
import type { DeployStatus, DeployTrigger, DeployAction } from '@/lib/deploy/types';

// Issue 15: use underscores consistently (in_sync, not in-sync)
export type SyncStatus = 'in_sync' | 'pending' | 'failed' | 'unknown';

export type DeployMode = 'auto' | 'manual';

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
export interface StackDetail extends Pick<StackSummary, 'name' | 'host' | 'syncStatus' | 'deployMode' | 'icon'> {
  composeContent: string;
  lastDeployCommitSha: string | null;
  currentCommitSha: string;
  variableNames: string[];
}

/** Serialized deploy record for API responses (Date → string vs canonical DeployRecord). */
export interface StackDeployRecord {
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

/** Request to trigger a deploy from the UI — reuses canonical DeployAction. */
export interface UIDeployRequest {
  stack: string;
  host: string;
  action: DeployAction;
}

/** Live container status for a single container within a stack. */
export interface StackContainer {
  id: string;
  name: string;
  status: string;
  image: string;
}

/** Live status entry for a stack as received from the SSE endpoint. */
export interface StackStatusEntry {
  stack: string;
  host: string;
  containers: StackContainer[];
  updated_at: string;
}
