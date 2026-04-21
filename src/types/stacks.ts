// Re-export canonical types from deploy layer to avoid duplication (Issue 12)
export type { DeployAction, DeployStatus, DeployTrigger } from '@/lib/deploy/types';
import type { DeployAction, DeployStatus, DeployTrigger } from '@/lib/deploy/types';

// Issue 15: use underscores consistently (in_sync, not in-sync)
export type SyncStatus = 'in_sync' | 'pending' | 'in_progress' | 'failed' | 'unknown';

export type DeployMode = 'auto' | 'manual';
export type StackDriftKind = 'ghost' | 'untracked' | 'content';
export type StackDriftResolution = 'trust_repo' | 'trust_agent' | 'remove';

interface StackDriftItemBase {
  host: string;
  stack: string;
  latestDeployStatus: DeployStatus | null;
}

/**
 * Drift between the repo's view of a stack and the agent's filesystem.
 * Discriminated on `kind` so consumers cannot read a hash that isn't present.
 */
export type StackDriftItem =
  | (StackDriftItemBase & { kind: 'ghost'; repoComposeHash: string })
  | (StackDriftItemBase & { kind: 'untracked'; agentComposeHash: string })
  | (StackDriftItemBase & { kind: 'content'; repoComposeHash: string; agentComposeHash: string });

export interface StackDriftSummary {
  total: number;
  ghost: number;
  untracked: number;
  content: number;
}

export interface StackDriftScanError {
  host: string;
  message: string;
}

export interface StackDriftReport {
  items: StackDriftItem[];
  summary: StackDriftSummary;
  scanErrors: StackDriftScanError[];
}

/**
 * Discriminated on `outcome` so the UI doesn't need to non-null-assert
 * `deployId`/`commitSha` on branches where the other field is the payload.
 */
export type StackDriftResolutionResult =
  | { outcome: 'deploy-queued' | 'teardown-queued'; deployId: number }
  | { outcome: 'repo-synced' | 'repo-removed'; commitSha: string };

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
}

/** Live status entry for a stack as received from the SSE endpoint. */
export interface StackStatusEntry {
  stack: string;
  host: string;
  containers: StackContainer[];
  updated_at: string;
}
