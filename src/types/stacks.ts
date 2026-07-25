// Re-export canonical types from deploy layer to avoid duplication (Issue 12)
export type { DeployAction, DeployStatus, DeployTrigger } from '@/lib/deploy/types';
import type { DeployAction, DeployStatus, DeployTrigger } from '@/lib/deploy/types';
import type { ContainerPort, ContainerMount } from '@/types/docker-inventory';

// Issue 15: use underscores consistently (in_sync, not in-sync)
export type SyncStatus = 'in_sync' | 'pending' | 'in_progress' | 'failed' | 'unknown';

export type DeployMode = 'auto' | 'manual';

export type StackDriftKind = 'ghost' | 'untracked' | 'content';

/**
 * Drift between the repo's view of a stack and the agent's filesystem.
 * `untracked` carries no `latestDeployStatus`: the repo has no record of a stack it
 * does not track.
 */
export type StackDriftItem =
  | { kind: 'ghost'; host: string; stack: string; repoComposeHash: string; latestDeployStatus: DeployStatus }
  | { kind: 'untracked'; host: string; stack: string; agentComposeHash: string }
  | {
      kind: 'content';
      host: string;
      stack: string;
      repoComposeHash: string;
      agentComposeHash: string;
      latestDeployStatus: DeployStatus;
    };

export interface StackDriftSummary {
  total: number;
  ghost: number;
  untracked: number;
  content: number;
}

/** `stack` is set when the failure is scoped to one stack; absent when the whole host scan failed. */
export interface StackDriftScanError {
  host: string;
  stack?: string;
  message: string;
}

export interface StackDriftReport {
  items: StackDriftItem[];
  summary: StackDriftSummary;
  scanErrors: StackDriftScanError[];
}

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
  action: DeployAction;
  forceRecreate: boolean;
  logs: string | null;
  createdAt: string;
}

/** Request to trigger a deploy from the UI; reuses canonical DeployAction. */
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
  /** Docker Compose service name from the container label, or null if the container has no compose service association. */
  service: string | null;
  ports: ContainerPort[];
  mounts: ContainerMount[];
}

/** Live status entry for a stack as received from the SSE endpoint. */
export interface StackStatusEntry {
  stack: string;
  host: string;
  containers: StackContainer[];
  updated_at: string;
}
