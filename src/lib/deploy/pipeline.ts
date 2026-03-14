import type { AgentClient } from '@/lib/clients/agent-client';
import type { DeployRepository } from '@/lib/database/repositories/deploy-repository';
import type { ManagedHostsRepository } from '@/lib/database/repositories/managed-hosts-repository';
import type { DeployRequest, DeployStatus, ManagedHost, SecretResolver } from '@/lib/deploy/types';
import { detectChanges } from '@/lib/deploy/change-detection';
import { extractVariableReferences } from '@/lib/deploy/secret-resolver';

interface PipelineResult {
  status: DeployStatus;
  logs: string;
  deployId?: number;
}

interface PipelineDeps {
  deployRepo: DeployRepository;
  hostsRepo: ManagedHostsRepository;
  agentClientFactory: (agentUrl: string, agentToken: string) => AgentClient;
  secretResolver: SecretResolver;
}

/**
 * Trigger-agnostic deploy pipeline.
 * Validates -> detects changes -> resolves secrets -> dispatches to agent -> records result.
 */
export class DeployPipeline {
  private readonly deployRepo: DeployRepository;
  private readonly hostsRepo: ManagedHostsRepository;
  private readonly agentClientFactory: PipelineDeps['agentClientFactory'];
  private readonly secretResolver: SecretResolver;

  constructor(deps: PipelineDeps) {
    this.deployRepo = deps.deployRepo;
    this.hostsRepo = deps.hostsRepo;
    this.agentClientFactory = deps.agentClientFactory;
    this.secretResolver = deps.secretResolver;
  }

  async execute(request: DeployRequest): Promise<PipelineResult> {
    // 1. Validate: host exists in managed_hosts
    const host = await this.hostsRepo.getByName(request.host);
    if (!host) {
      return { status: 'failed', logs: `Host "${request.host}" not found in managed_hosts` };
    }

    // 2. Concurrency check: one deploy per stack at a time
    const hasActive = await this.deployRepo.hasActiveDeployForStack(request.stack);
    if (hasActive) {
      return { status: 'failed', logs: `Stack "${request.stack}" already has an active deploy` };
    }

    // 3. Change detection (skip for teardown/restart -- always execute those)
    let composeHash = '';
    let envHash = '';
    let resolvedEnvContent = request.envContent;

    if (request.action === 'deploy') {
      // Resolve secrets
      const variables = extractVariableReferences(request.composeContent);
      if (variables.length > 0) {
        const secrets = await this.secretResolver.resolve(request.stack, variables);
        resolvedEnvContent = buildEnvContent(request.envContent, secrets);
      }

      const previousDeploy = await this.deployRepo.getLatestSuccessful(request.stack, request.host);
      const changeResult = detectChanges(request.composeContent, resolvedEnvContent, previousDeploy);
      composeHash = changeResult.composeHash;
      envHash = changeResult.envHash;

      if (!changeResult.changed) {
        const deployId = await this.deployRepo.insertDeploy({
          stack: request.stack,
          host: request.host,
          commitSha: request.commitSha,
          composeHash,
          envHash,
          status: 'no_change',
          trigger: request.trigger,
        });
        return { status: 'no_change', logs: 'No changes detected, skipping deploy', deployId };
      }
    }

    // 4. Insert deploy record
    const deployId = await this.deployRepo.insertDeploy({
      stack: request.stack,
      host: request.host,
      commitSha: request.commitSha,
      composeHash,
      envHash,
      status: request.autoApproved ? 'in_progress' : 'pending',
      trigger: request.trigger,
    });

    // Deduplicate older pending deploys for this stack
    await this.deployRepo.deduplicatePending(request.stack, deployId);

    // 5. If not auto-approved, stop here (UI will show pending state)
    if (!request.autoApproved) {
      return { status: 'pending', logs: 'Awaiting manual approval', deployId };
    }

    // 6. Mark as in_progress
    await this.deployRepo.updateStatus(deployId, 'in_progress');

    // 7. Dispatch to agent
    return this.dispatch(host, request, resolvedEnvContent, deployId);
  }

  /**
   * Resume a pending deploy (after manual approval).
   */
  async resumePending(deployId: number, host: ManagedHost, request: DeployRequest): Promise<PipelineResult> {
    await this.deployRepo.updateStatus(deployId, 'in_progress');
    return this.dispatch(host, request, request.envContent, deployId);
  }

  private async dispatch(
    host: ManagedHost,
    request: DeployRequest,
    envContent: string,
    deployId: number,
  ): Promise<PipelineResult> {
    try {
      const agent = this.agentClientFactory(host.agentUrl, '');

      let result;
      switch (request.action) {
        case 'deploy':
          result = await agent.deploy({
            stack: request.stack,
            composeContent: request.composeContent,
            envContent,
            action: 'deploy',
          });
          break;
        case 'teardown':
          result = await agent.teardown(request.stack);
          break;
        case 'restart':
          result = await agent.restart(request.stack);
          break;
      }

      const finalStatus: DeployStatus = result.success ? 'succeeded' : 'failed';
      await this.deployRepo.updateStatus(deployId, finalStatus, result.logs);

      return { status: finalStatus, logs: result.logs, deployId };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.deployRepo.updateStatus(deployId, 'failed', errorMsg);
      return { status: 'failed', logs: errorMsg, deployId };
    }
  }
}

/**
 * Merge existing env content with resolved secrets.
 * Secrets are appended to the env content. Existing keys in envContent
 * are NOT overridden by secrets (explicit env takes precedence).
 */
function buildEnvContent(existingEnv: string, secrets: Record<string, string>): string {
  const lines = existingEnv ? existingEnv.split('\n').filter(l => l.trim()) : [];
  const existingKeys = new Set(
    lines
      .filter(l => l.includes('=') && !l.startsWith('#'))
      .map(l => l.split('=')[0].trim())
  );

  for (const [key, value] of Object.entries(secrets)) {
    if (!existingKeys.has(key)) {
      lines.push(`${key}=${value}`);
    }
  }

  return lines.join('\n');
}
