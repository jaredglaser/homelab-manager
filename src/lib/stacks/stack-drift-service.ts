import type {
  AgentStackComposeResponse,
  AgentStackInventoryEntry,
} from '@homelab-manager/agent/types';
import type { DeployRecord } from '@/lib/deploy/types';
import type {
  StackDriftItem,
  StackDriftKind,
  StackDriftReport,
  StackDriftResolution,
  StackDriftResolutionResult,
  StackDriftScanError,
} from '@/types/stacks';

export interface RepoStackSnapshot {
  stack: string;
  host: string;
  autoDeploy: boolean;
  composeContent: string;
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
  agentStacksByHost: Map<string, AgentStackInventoryEntry[]>;
  scanErrors: StackDriftScanError[];
}

interface ResolveStackDriftInput {
  host: string;
  stack: string;
  resolution: StackDriftResolution;
  loadCurrentReport: () => Promise<StackDriftReport>;
  readRepoStack: (stack: string) => Promise<RepoStackSnapshot | null>;
  readAgentCompose: (host: string, stack: string) => Promise<AgentStackComposeResponse | null>;
  triggerDeploy: (input: {
    stack: string;
    host: string;
    action: 'deploy' | 'teardown';
  }) => Promise<{ deployId: number }>;
  deleteTrackedStack: (
    stack: string,
    teardown: boolean,
  ) => Promise<{ status: 'removed'; commitSha: string } | { status: 'teardown-pending'; deployId: number }>;
  syncRepoToAgent: (input: { stack: string; host: string; composeContent: string }) => Promise<{ commitSha: string }>;
}

const KIND_LABELS: Record<StackDriftKind, string> = {
  ghost: 'Ghost',
  untracked: 'Untracked',
  content: 'Content Drift',
};

const RESOLUTION_LABELS: Record<StackDriftResolution, string> = {
  trust_repo: 'Trust Repo',
  trust_agent: 'Trust Agent',
  remove: 'Remove',
};

export function getStackDriftKindLabel(kind: StackDriftKind): string {
  return KIND_LABELS[kind];
}

export function getStackDriftResolutionLabel(resolution: StackDriftResolution): string {
  return RESOLUTION_LABELS[resolution];
}

/**
 * `untracked` excludes `trust_repo` because there is no repo copy to redeploy;
 * the user must either adopt the agent's copy or tear it down.
 */
export function getAllowedStackDriftResolutions(kind: StackDriftKind): StackDriftResolution[] {
  if (kind === 'untracked') return ['trust_agent', 'remove'];
  return ['trust_repo', 'trust_agent', 'remove'];
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
      const agentStack = agentByName.get(repoStack.stack);
      const latestDeploy = latestDeployMap.get(`${repoStack.host}/${repoStack.stack}`) ?? null;

      if (!agentStack) {
        items.push({
          host: repoStack.host,
          stack: repoStack.stack,
          kind: 'ghost',
          repoComposeHash: repoStack.composeHash,
          latestDeployStatus: latestDeploy?.status ?? null,
        });
        continue;
      }

      if (agentStack.composeHash !== repoStack.composeHash) {
        items.push({
          host: repoStack.host,
          stack: repoStack.stack,
          kind: 'content',
          repoComposeHash: repoStack.composeHash,
          agentComposeHash: agentStack.composeHash,
          latestDeployStatus: latestDeploy?.status ?? null,
        });
      }
    }

    for (const agentStack of agentStacks) {
      if (repoByName.has(agentStack.name)) continue;
      items.push({
        host: host.name,
        stack: agentStack.name,
        kind: 'untracked',
        agentComposeHash: agentStack.composeHash,
        latestDeployStatus: null,
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

/**
 * Re-scan before acting so a stale UI can't drive a destructive resolution
 * against a stack whose drift state has changed since the user clicked.
 * When a re-scan records a scanError for the target host, surface that error
 * directly instead of the misleading "no drift item found" path (the host
 * gets skipped in `buildStackDriftReport` when it's in scanErrors).
 */
export async function resolveStackDriftItem(input: ResolveStackDriftInput): Promise<StackDriftResolutionResult> {
  const report = await input.loadCurrentReport();

  const hostScanError = report.scanErrors.find((error) => error.host === input.host);
  if (hostScanError) {
    throw new Error(`Cannot resolve drift on "${input.host}": ${hostScanError.message}`);
  }

  const item = report.items.find((candidate) => candidate.host === input.host && candidate.stack === input.stack);
  if (!item) {
    throw new Error(`No drift item found for "${input.host}/${input.stack}"`);
  }

  const allowed = getAllowedStackDriftResolutions(item.kind);
  if (!allowed.includes(input.resolution)) {
    throw new Error(`Resolution "${input.resolution}" is not valid for drift kind "${item.kind}"`);
  }

  if (input.resolution === 'trust_repo') {
    const repoStack = await input.readRepoStack(input.stack);
    if (!repoStack) {
      throw new Error(`Stack "${input.stack}" is not tracked in the repo`);
    }
    const result = await input.triggerDeploy({
      stack: input.stack,
      host: input.host,
      action: 'deploy',
    });
    return { outcome: 'deploy-queued', deployId: result.deployId };
  }

  if (input.resolution === 'trust_agent') {
    if (item.kind === 'ghost') {
      const result = await input.deleteTrackedStack(input.stack, false);
      if (result.status !== 'removed') {
        throw new Error(`Unexpected delete result while trusting agent for "${input.stack}"`);
      }
      return { outcome: 'repo-removed', commitSha: result.commitSha };
    }

    const compose = await input.readAgentCompose(input.host, input.stack);
    if (!compose) {
      throw new Error(`Stack "${input.stack}" was not found on agent host "${input.host}"`);
    }
    const result = await input.syncRepoToAgent({
      stack: input.stack,
      host: input.host,
      composeContent: compose.composeContent,
    });
    return { outcome: 'repo-synced', commitSha: result.commitSha };
  }

  if (item.kind !== 'untracked') {
    const result = await input.deleteTrackedStack(input.stack, true);
    return result.status === 'teardown-pending'
      ? { outcome: 'teardown-queued', deployId: result.deployId }
      : { outcome: 'repo-removed', commitSha: result.commitSha };
  }

  const result = await input.triggerDeploy({
    stack: input.stack,
    host: input.host,
    action: 'teardown',
  });
  return { outcome: 'teardown-queued', deployId: result.deployId };
}
