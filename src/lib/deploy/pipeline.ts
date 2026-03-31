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
  /** Resolve the agent bearer token for a given host. */
  tokenResolver: (host: ManagedHost) => Promise<string> | string;
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
  private readonly tokenResolver: PipelineDeps['tokenResolver'];

  constructor(deps: PipelineDeps) {
    this.deployRepo = deps.deployRepo;
    this.hostsRepo = deps.hostsRepo;
    this.agentClientFactory = deps.agentClientFactory;
    this.secretResolver = deps.secretResolver;
    this.tokenResolver = deps.tokenResolver;
  }

  async execute(request: DeployRequest): Promise<PipelineResult> {
    // 1. Validate: host exists in managed_hosts
    const host = await this.hostsRepo.getByName(request.host);
    if (!host) {
      throw new Error(`Host "${request.host}" not found in managed_hosts. Add it via the Hosts page first.`);
    }

    // 2. Change detection (skip for teardown/restart -- always execute those)
    let composeHash = '';
    let envHash = '';
    const resolvedEnvContent = await this.resolveEnv(request);

    if (request.action === 'deploy' && request.trigger !== 'manual_rollback') {
      const previousDeploy = await this.deployRepo.getLatestSuccessful(request.stack, request.host);
      const changeResult = detectChanges(request.composeContent, resolvedEnvContent, previousDeploy);
      composeHash = changeResult.composeHash;
      envHash = changeResult.envHash;

      if (!changeResult.changed && !request.forceRecreate) {
        const deployId = await this.deployRepo.insertDeploy({
          stack: request.stack,
          host: request.host,
          commitSha: request.commitSha,
          composeHash,
          envHash,
          status: 'no_change',
          trigger: request.trigger,
          action: request.action,
          forceRecreate: request.action === 'deploy' ? request.forceRecreate : false,
        });
        try {
          await this.deployRepo.notifyStackChange(request.stack, request.host);
        } catch (err) {
          console.error(`Failed to notify stack change for "${request.stack}":`, err);
        }
        return { status: 'no_change', logs: 'No changes detected, skipping deploy', deployId };
      }
    }

    // 3. Atomic insert — the partial unique index rejects if an active deploy exists
    const deployId = await this.deployRepo.insertDeployIfNoActive({
      stack: request.stack,
      host: request.host,
      commitSha: request.commitSha,
      composeHash,
      envHash,
      status: 'pending',
      trigger: request.trigger,
      action: request.action,
      forceRecreate: request.action === 'deploy' ? request.forceRecreate : false,
    });

    if (deployId === null) {
      return { status: 'failed', logs: `Stack "${request.stack}" already has an active deploy` };
    }

    // Deduplicate older pending deploys for this stack+host
    try {
      await this.deployRepo.deduplicatePending(request.stack, request.host, deployId);
    } catch (err) {
      console.error(`Failed to deduplicate pending deploys for stack "${request.stack}":`, err);
    }

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
   * Performs the same env merge / secret resolution that execute uses.
   */
  async resumePending(deployId: number, host: ManagedHost, request: DeployRequest): Promise<PipelineResult> {
    const deploy = await this.deployRepo.getById(deployId);
    if (!deploy || deploy.status !== 'pending') {
      return { status: 'failed', logs: `Deploy ${deployId} is not in pending state`, deployId };
    }

    await this.deployRepo.updateStatus(deployId, 'in_progress');

    let resolvedEnvContent: string;
    try {
      resolvedEnvContent = await this.resolveEnv(request);
    } catch (err) {
      const errorMsg = `Secret resolution failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error(errorMsg, err);
      try {
        await this.deployRepo.updateStatus(deployId, 'failed', errorMsg);
      } catch (dbErr) {
        console.error(`Failed to record deploy failure for deploy ${deployId}:`, dbErr);
      }
      try {
        await this.deployRepo.notifyStackChange(request.stack, request.host);
      } catch (notifyErr) {
        console.error(`Failed to notify stack change for deploy ${deployId} ("${request.stack}" on "${request.host}"):`, notifyErr);
      }
      return { status: 'failed', logs: errorMsg, deployId };
    }

    return this.dispatch(host, request, resolvedEnvContent, deployId);
  }

  private async resolveEnv(request: DeployRequest): Promise<string> {
    if (request.action !== 'deploy') return '';

    const variables = extractVariableReferences(request.composeContent);
    if (variables.length === 0) return request.envContent;

    const secrets = await this.secretResolver.resolve(request.stack, variables);
    return buildEnvContent(request.envContent, secrets);
  }

  private async dispatch(
    host: ManagedHost,
    request: DeployRequest,
    envContent: string,
    deployId: number,
  ): Promise<PipelineResult> {
    let result;
    try {
      const token = await this.tokenResolver(host);
      const agent = this.agentClientFactory(host.agentUrl, token);

      switch (request.action) {
        case 'deploy':
          result = await agent.deploy({
            stack: request.stack,
            composeContent: request.composeContent,
            envContent,
            action: 'deploy',
            forceRecreate: request.forceRecreate,
          });
          break;
        case 'teardown':
          result = await agent.teardown(request.stack);
          break;
        case 'restart':
          result = await agent.restart(request.stack);
          break;
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`Deploy dispatch failed for stack "${request.stack}" on host "${host.name}":`, err);
      try {
        await this.deployRepo.updateStatus(deployId, 'failed', errorMsg);
      } catch (dbErr) {
        console.error(`Failed to record deploy failure for deploy ${deployId}:`, dbErr);
      }
      try {
        await this.deployRepo.notifyStackChange(request.stack, host.name);
      } catch (notifyErr) {
        console.error(`Failed to notify stack change for deploy ${deployId} ("${request.stack}" on "${host.name}"):`, notifyErr);
      }
      return { status: 'failed', logs: errorMsg, deployId };
    }

    // Record result outside try — a DB failure here must not be misattributed to the agent
    const finalStatus: DeployStatus = result.success ? 'succeeded' : 'failed';
    await this.deployRepo.updateStatus(deployId, finalStatus, result.logs);
    try {
      await this.deployRepo.notifyStackChange(request.stack, host.name);
    } catch (err) {
      console.error(`Failed to notify stack change for "${request.stack}":`, err);
    }

    return { status: finalStatus, logs: result.logs, deployId };
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
      const sanitized = value.replaceAll(/[\r\n]/g, '').replaceAll('"', '\\"');
      lines.push(`${key}="${sanitized}"`);
    }
  }

  return lines.join('\n');
}
