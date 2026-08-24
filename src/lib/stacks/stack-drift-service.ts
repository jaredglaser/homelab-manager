/**
 * Pure classification of drift between the stack repo and what each agent host
 * actually has on disk. Reporting only: nothing here mutates the repo or a host.
 */

import type { AgentStackInventoryEntry, AgentStackInventoryError } from '@homelab-manager/agent/types';
import type { DeployRecord } from '@/lib/deploy/types';
import type {
  StackDriftItem,
  StackDriftKind,
  StackDriftReport,
  StackDriftResolution,
  StackDriftScanError,
} from '@/types/stacks';
import { computeSyncStatus } from '@/lib/stacks/stack-mappers';

export interface RepoStackSnapshot {
  stack: string;
  host: string;
  autoDeploy: boolean;
  composeHash: string;
}

interface ScanHost {
  name: string;
  dockerEnabled: boolean;
}

interface BuildStackDriftReportInput {
  repoStacks: RepoStackSnapshot[];
  hosts: ScanHost[];
  latestDeploys: DeployRecord[];
  currentHeadSha: string | null;
  agentStacksByHost: Map<string, AgentStackInventoryEntry[]>;
  agentStackErrorsByHost?: Map<string, AgentStackInventoryError[]>;
  scanErrors: StackDriftScanError[];
}

const KIND_LABELS: Record<StackDriftKind, string> = {
  ghost: 'Ghost',
  untracked: 'Untracked',
  content: 'Content Drift',
};

export function getStackDriftKindLabel(kind: StackDriftKind): string {
  return KIND_LABELS[kind];
}

/**
 * Resolutions offered per drift kind, in the order the UI lists them.
 * `untracked` has no `trust_repo` entry: the repo says nothing about the stack,
 * so "the repo wins" and "remove it from the host" are the same operation, and
 * `remove` names it without pretending the repo holds a version to restore.
 */
const KIND_RESOLUTIONS: Record<StackDriftKind, StackDriftResolution[]> = {
  ghost: ['trust_repo', 'trust_agent'],
  untracked: ['trust_agent', 'remove'],
  content: ['trust_repo', 'trust_agent'],
};

const RESOLUTION_LABELS: Record<StackDriftKind, Record<StackDriftResolution, string>> = {
  ghost: {
    trust_repo: 'Redeploy from repo',
    trust_agent: 'Drop from repo',
    remove: 'Drop from repo',
  },
  untracked: {
    trust_repo: 'Tear down on host',
    trust_agent: 'Adopt into repo',
    remove: 'Tear down on host',
  },
  content: {
    trust_repo: 'Redeploy repo version',
    trust_agent: 'Adopt host version',
    remove: 'Tear down on host',
  },
};

export function getAllowedStackDriftResolutions(kind: StackDriftKind): StackDriftResolution[] {
  return KIND_RESOLUTIONS[kind];
}

export function getStackDriftResolutionLabel(kind: StackDriftKind, resolution: StackDriftResolution): string {
  return RESOLUTION_LABELS[kind][resolution];
}

/** The two resolutions that only add state: deploying to a host that has nothing, and committing a stack git does not yet track. */
const NON_DESTRUCTIVE = new Set(['ghost:trust_repo', 'untracked:trust_agent']);

export function isDestructiveStackDriftResolution(kind: StackDriftKind, resolution: StackDriftResolution): boolean {
  return !NON_DESTRUCTIVE.has(`${kind}:${resolution}`);
}

export function buildStackDriftReport(input: BuildStackDriftReportInput): StackDriftReport {
  const latestDeployMap = new Map(input.latestDeploys.map((deploy) => [`${deploy.host}/${deploy.stack}`, deploy]));
  const scanErrorHosts = new Set(input.scanErrors.map((error) => error.host));
  const items: StackDriftItem[] = [];
  const stackScanErrors: StackDriftScanError[] = [];

  for (const host of input.hosts) {
    if (!host.dockerEnabled || scanErrorHosts.has(host.name)) continue;

    const repoStacks = input.repoStacks.filter((stack) => stack.host === host.name);
    const repoByName = new Map(repoStacks.map((stack) => [stack.stack, stack]));
    const agentStacks = input.agentStacksByHost.get(host.name) ?? [];
    const agentByName = new Map(agentStacks.map((stack) => [stack.name, stack]));

    // A stack the agent could not read is present on disk but has no hash. Classifying it
    // would report a live stack as ghost, so it is excluded and reported as a scan error.
    const agentStackErrors = input.agentStackErrorsByHost?.get(host.name) ?? [];
    const unreadableStacks = new Set(agentStackErrors.map((error) => error.name));
    for (const error of agentStackErrors) {
      stackScanErrors.push({ host: host.name, stack: error.name, message: error.message });
    }

    for (const repoStack of repoStacks) {
      if (unreadableStacks.has(repoStack.stack)) continue;
      const latestDeploy = latestDeployMap.get(`${repoStack.host}/${repoStack.stack}`) ?? null;
      // Only a stack the repo believes is deployed and current can drift. Never-deployed
      // (createStackInRepo commits without deploying), failed, and edited-since-deploy
      // stacks are already reported through computeSyncStatus, not as drift.
      if (!latestDeploy || computeSyncStatus(latestDeploy, input.currentHeadSha) !== 'in_sync') continue;

      const agentStack = agentByName.get(repoStack.stack);
      if (!agentStack) {
        items.push({
          kind: 'ghost',
          host: repoStack.host,
          stack: repoStack.stack,
          repoComposeHash: repoStack.composeHash,
          latestDeployStatus: latestDeploy.status,
        });
        continue;
      }

      if (agentStack.composeHash !== repoStack.composeHash) {
        items.push({
          kind: 'content',
          host: repoStack.host,
          stack: repoStack.stack,
          repoComposeHash: repoStack.composeHash,
          agentComposeHash: agentStack.composeHash,
          latestDeployStatus: latestDeploy.status,
        });
      }
    }

    for (const agentStack of agentStacks) {
      if (repoByName.has(agentStack.name)) continue;
      items.push({
        kind: 'untracked',
        host: host.name,
        stack: agentStack.name,
        agentComposeHash: agentStack.composeHash,
      });
    }
  }

  items.sort((a, b) =>
    a.host.localeCompare(b.host) ||
    a.stack.localeCompare(b.stack) ||
    a.kind.localeCompare(b.kind),
  );

  return {
    items,
    summary: {
      total: items.length,
      ghost: items.filter((item) => item.kind === 'ghost').length,
      untracked: items.filter((item) => item.kind === 'untracked').length,
      content: items.filter((item) => item.kind === 'content').length,
    },
    scanErrors: [...input.scanErrors, ...stackScanErrors],
  };
}
