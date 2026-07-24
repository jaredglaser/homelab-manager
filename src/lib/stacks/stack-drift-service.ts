/**
 * Pure classification of drift between the stack repo and what each agent host
 * actually has on disk. Reporting only: nothing here mutates the repo or a host.
 */

import type { AgentStackInventoryEntry } from '@homelab-manager/agent/types';
import type { DeployRecord } from '@/lib/deploy/types';
import type {
  StackDriftItem,
  StackDriftKind,
  StackDriftReport,
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

export function buildStackDriftReport(input: BuildStackDriftReportInput): StackDriftReport {
  const latestDeployMap = new Map(input.latestDeploys.map((deploy) => [`${deploy.host}/${deploy.stack}`, deploy]));
  const scanErrorHosts = new Set(input.scanErrors.map((error) => error.host));
  const items: StackDriftItem[] = [];

  for (const host of input.hosts) {
    if (!host.dockerEnabled || scanErrorHosts.has(host.name)) continue;

    const repoStacks = input.repoStacks.filter((stack) => stack.host === host.name);
    const repoByName = new Map(repoStacks.map((stack) => [stack.stack, stack]));
    const agentStacks = input.agentStacksByHost.get(host.name) ?? [];
    const agentByName = new Map(agentStacks.map((stack) => [stack.name, stack]));

    for (const repoStack of repoStacks) {
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
    scanErrors: input.scanErrors,
  };
}
