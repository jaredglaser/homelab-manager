import type { AgentClient } from '@/lib/clients/agent-client';
import type { DeployRepository, InsertDeployParams, QueuedDeploy } from '@/lib/database/repositories/deploy-repository';
import type { HostRepository, ManagedHost } from '@/lib/database/repositories/host-repository';
import type { DeployRecord, DeployRequest, DeployStatus, SecretResolver } from '@/lib/deploy/types';
import { computeHash, detectChanges } from '@/lib/deploy/change-detection';
import { extractVariableReferences } from '@/lib/deploy/secret-resolver';

interface PipelineResult {
  status: DeployStatus;
  logs: string;
  deployId?: number;
}

/**
 * Writes to the stacks git repo. The pipeline calls this after a successful
 * teardown when `postSuccess: 'removeFromManifest'` is set.
 */
export interface StackRepoWriter {
  removeStackFromManifest(stackName: string): Promise<{ commitSha: string }>;
}

interface PipelineDeps {
  deployRepo: DeployRepository;
  hostsRepo: HostRepository;
  agentClientFactory: (agentUrl: string, signer: () => Promise<string>) => AgentClient;
  secretResolver: SecretResolver;
  /** Resolve a JWT signer closure for a given host. */
  tokenResolver: (host: ManagedHost) => Promise<() => Promise<string>>;
  /** Writes to the stacks git repo for postSuccess hooks. */
  stackRepoWriter: StackRepoWriter;
}

/**
 * Trigger-agnostic deploy pipeline.
 * Validates -> detects changes -> resolves secrets -> dispatches to agent -> records result.
 */
export class DeployPipeline {
  private readonly deployRepo: DeployRepository;
  private readonly hostsRepo: HostRepository;
  private readonly agentClientFactory: PipelineDeps['agentClientFactory'];
  private readonly secretResolver: SecretResolver;
  private readonly tokenResolver: PipelineDeps['tokenResolver'];
  private readonly stackRepoWriter: StackRepoWriter;

  constructor(deps: PipelineDeps) {
    this.deployRepo = deps.deployRepo;
    this.hostsRepo = deps.hostsRepo;
    this.agentClientFactory = deps.agentClientFactory;
    this.secretResolver = deps.secretResolver;
    this.tokenResolver = deps.tokenResolver;
    this.stackRepoWriter = deps.stackRepoWriter;
  }

  /**
   * @param queuedAt Original queue timestamp when redispatching a drained
   * request. Passed back to enqueueDeploy if the request gets re-queued so it
   * can never replace a newer queued push.
   */
  async execute(request: DeployRequest, queuedAt?: Date): Promise<PipelineResult> {
    // 1. Validate: host exists in managed_hosts
    const host = await this.hostsRepo.findByName(request.host);
    if (!host) {
      throw new Error(`Host "${request.host}" not found in managed_hosts. Add it via the Hosts page first.`);
    }

    // 2. Change detection (skip for teardown -- always execute those)
    let composeHash = '';
    let envHash = '';
    const resolvedEnvContent = await this.resolveEnv(request);

    if (request.action === 'deploy' && request.trigger !== 'manual_rollback') {
      const previousDeploy = await this.deployRepo.getLatestSuccessful(request.stack, request.host);
      const changeResult = detectChanges(request.composeContent, resolvedEnvContent, previousDeploy);
      composeHash = changeResult.composeHash;
      envHash = changeResult.envHash;

      if (!changeResult.changed && request.trigger === 'git_push' && !request.forceRecreate) {
        let deployId: number | undefined;
        try {
          deployId = await this.deployRepo.insertDeploy({
            stack: request.stack,
            host: request.host,
            commitSha: request.commitSha,
            composeHash,
            envHash,
            status: 'no_change',
            trigger: request.trigger,
            action: request.action,
            forceRecreate: request.action === 'deploy' ? request.forceRecreate : false,
            postSuccess: request.postSuccess ?? null,
          });
        } catch (err) {
          console.error(`Failed to insert no_change deploy record for stack "${request.stack}":`, err);
          return { status: 'no_change', logs: 'No changes detected, skipping deploy', deployId: undefined };
        }

        // postSuccess is only set for teardown actions, which never reach the no_change path.
        // This branch exists only for future-proofing if new action types are added.
        if (deployId !== undefined && request.postSuccess === 'removeFromManifest') {
          try {
            await this.stackRepoWriter.removeStackFromManifest(request.stack);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(
              `[Pipeline] postSuccess manifest delete failed for "${request.stack}" (no_change path):`,
              err,
            );
            try {
              await this.deployRepo.updateStatus(
                deployId,
                'failed',
                `No change, but manifest delete failed: ${errMsg}`,
              );
            } catch (updateErr) {
              console.error('[Pipeline] Failed to record postSuccess failure status:', updateErr);
            }
            try {
              await this.deployRepo.notifyStackChange(request.stack, request.host, {
                deployId,
                status: 'failed',
                action: request.action,
                trigger: request.trigger,
                message: errMsg,
              });
            } catch (notifyErr) {
              console.error(`Failed to notify stack change for "${request.stack}":`, notifyErr);
            }
            return { status: 'failed', logs: errMsg, deployId };
          }
        }

        try {
          // deployId is always set here: the only early return above (insertDeploy
          // failure) happens inside the try/catch before this point.
          await this.deployRepo.notifyStackChange(request.stack, request.host, {
            deployId: deployId as number,
            status: 'no_change',
            action: request.action,
            trigger: request.trigger,
          });
        } catch (err) {
          console.error(`Failed to notify stack change for "${request.stack}":`, err);
        }
        return { status: 'no_change', logs: 'No changes detected, skipping deploy', deployId };
      }
    } else if (request.action === 'update') {
      // Hashes must match the deploy path exactly: a later identical deploy
      // detects no_change against this row via getLatestSuccessful.
      composeHash = computeHash(request.composeContent);
      envHash = computeHash(resolvedEnvContent);
    }

    const insertParams = {
      stack: request.stack,
      host: request.host,
      commitSha: request.commitSha,
      composeHash,
      envHash,
      status: 'pending' as DeployStatus,
      trigger: request.trigger,
      action: request.action,
      forceRecreate: request.action === 'deploy' ? request.forceRecreate : false,
      postSuccess: request.postSuccess ?? null,
    };

    // 3. Atomic insert: the partial unique index rejects if an active deploy exists
    const deployId = await this.deployRepo.insertDeployIfNoActive(insertParams);

    if (deployId === null) {
      // A git push blocked by an active deploy must not be dropped: the newest
      // commit would silently never deploy. Queue it for dispatch after the
      // active deploy reaches a terminal state. UI triggers keep the immediate
      // failed response so the user sees the conflict right away.
      if (request.trigger === 'git_push') {
        return this.queueBlockedPush(request, insertParams, queuedAt);
      }
      return { status: 'failed', logs: await this.describeActiveDeploy(request.stack, request.host) };
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
    try {
      await this.deployRepo.updateStatus(deployId, 'in_progress');
    } catch (err) {
      const errorMsg = `Failed to mark deploy as in_progress: ${err instanceof Error ? err.message : String(err)}`;
      console.error(errorMsg, err);
      try {
        await this.deployRepo.updateStatus(deployId, 'failed', errorMsg);
      } catch (dbErr) {
        console.error(`Failed to record deploy failure for deploy ${deployId}:`, dbErr);
      }
      return { status: 'failed', logs: errorMsg, deployId };
    }
    await this.notifyInProgress(request, deployId);

    // 7. Dispatch to agent
    return this.dispatch(host, request, resolvedEnvContent, deployId);
  }

  /**
   * Resume a pending deploy (after manual approval).
   * Performs the same env merge / secret resolution that execute uses.
   */
  async resumePending(deployId: number, host: ManagedHost, request: DeployRequest): Promise<PipelineResult> {
    const claimed = await this.deployRepo.claimPending(deployId);
    if (!claimed) {
      return { status: 'failed', logs: `Deploy ${deployId} is not in pending state or was already approved`, deployId };
    }
    await this.notifyInProgress(request, deployId);

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
        await this.deployRepo.notifyStackChange(request.stack, request.host, {
          deployId,
          status: 'failed',
          action: request.action,
          trigger: request.trigger,
          message: errorMsg,
        });
      } catch (notifyErr) {
        console.error(`Failed to notify stack change for deploy ${deployId} ("${request.stack}" on "${request.host}"):`, notifyErr);
      }
      await this.drainQueue(request.stack, request.host);
      return { status: 'failed', logs: errorMsg, deployId };
    }

    return this.dispatch(host, request, resolvedEnvContent, deployId);
  }

  // The agent call can hold the triggering request for up to 16 minutes; a client
  // that reloads in that window only learns the deploy is running from this frame.
  private async notifyInProgress(request: DeployRequest, deployId: number): Promise<void> {
    try {
      await this.deployRepo.notifyStackChange(request.stack, request.host, {
        deployId,
        status: 'in_progress',
        action: request.action,
        trigger: request.trigger,
      });
    } catch (err) {
      console.error(`Failed to notify deploy ${deployId} start for "${request.stack}" on "${request.host}":`, err);
    }
  }

  private async describeActiveDeploy(stack: string, host: string): Promise<string> {
    const active = await this.deployRepo.getActiveDeploy(stack, host).catch((err: unknown) => {
      console.error(`[Pipeline] Failed to look up the active deploy for "${stack}" on "${host}":`, err);
      return null;
    });
    if (!active) return `Stack "${stack}" already has an active deploy`;
    const noun = ACTIVE_DEPLOY_NOUNS[active.action];
    if (active.status === 'pending') {
      return `Stack "${stack}" has ${noun} (#${active.id}) awaiting approval. Approve or reject it in the Deploys tab first.`;
    }
    return `Stack "${stack}" already has ${noun} (#${active.id}) in progress, running for ${formatElapsed(active.startedAt ?? active.createdAt)}. Wait for it to finish before starting another.`;
  }

  private async queueBlockedPush(
    request: DeployRequest,
    insertParams: InsertDeployParams,
    queuedAt?: Date,
  ): Promise<PipelineResult> {
    const logs = `Stack "${request.stack}" has an active deploy; queued commit ${request.commitSha} for dispatch after it completes`;
    let won: boolean;
    try {
      won = await this.deployRepo.enqueueDeploy(request, queuedAt);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Pipeline] Failed to queue blocked git push for stack "${request.stack}":`, err);
      return { status: 'failed', logs: `Stack "${request.stack}" already has an active deploy and queueing failed: ${errMsg}` };
    }

    if (!won) {
      return { status: 'no_change', logs: `Queued commit ${request.commitSha} superseded by a newer push` };
    }

    const deployId = await this.recordQueuedDeploy(request, insertParams, logs);
    return deployId === null ? { status: 'queued', logs } : { status: 'queued', logs, deployId };
  }

  /**
   * Write the `queued` deploy_history marker so a blocked push is visible in the
   * history list and on the stack-status channel. Best-effort: the queue row is
   * the source of truth, so a marker failure must not fail the push.
   */
  private async recordQueuedDeploy(
    request: DeployRequest,
    insertParams: InsertDeployParams,
    logs: string,
  ): Promise<number | null> {
    try {
      const deployId = await this.deployRepo.recordQueuedDeploy({ ...insertParams, status: 'queued' });
      await this.deployRepo.notifyStackChange(request.stack, request.host, {
        deployId,
        status: 'queued',
        action: request.action,
        trigger: request.trigger,
        message: logs,
      });
      return deployId;
    } catch (err) {
      console.error(`[Pipeline] Failed to record queued deploy marker for stack "${request.stack}":`, err);
      return null;
    }
  }

  /**
   * Dispatch the newest queued git push for stack+host, if one exists. Runs
   * after a deploy reaches a terminal state. If the dequeued request loses a
   * race against a concurrent push (its insert hits the active-deploy index
   * again), execute re-enqueues it with the original queue timestamp so it
   * cannot replace a newer queued push.
   */
  private async drainQueue(stack: string, host: string): Promise<void> {
    const queued = await this.deployRepo.dequeueDeploy(stack, host).catch((err: unknown) => {
      console.error(`[Pipeline] Failed to read deploy queue for "${stack}" on "${host}":`, err);
      return null;
    });
    if (!queued) return;

    const stale = await this.findSupersedingDeploy(queued);
    if (stale) {
      const logs = `Discarded queued commit ${queued.request.commitSha}: commit ${stale.commitSha} deployed successfully after it was queued`;
      console.info(`[Pipeline] ${logs}`);
      await this.resolveQueuedMarker(queued.request, logs);
      return;
    }

    console.info(
      `[Pipeline] Dispatching queued deploy for "${stack}" on "${host}" (commit ${queued.request.commitSha})`,
    );
    await this.deployRepo.clearQueuedDeploy(stack, host).catch((err: unknown) => {
      console.error(`[Pipeline] Failed to clear queued marker for "${stack}" on "${host}":`, err);
    });
    try {
      await this.execute(queued.request, queued.queuedAt);
    } catch (err) {
      console.error(`[Pipeline] Queued deploy dispatch failed for "${stack}" on "${host}":`, err);
    }
  }

  /**
   * A dequeued request must never deploy over a newer commit. Startup recovery
   * and the watchdog both fail an active deploy without draining, so a queued
   * row can outlive the deploy it was waiting on and silently revert the stack.
   */
  private async findSupersedingDeploy(queued: QueuedDeploy): Promise<DeployRecord | null> {
    const latest = await this.deployRepo
      .getLatestSuccessful(queued.request.stack, queued.request.host)
      .catch((err: unknown) => {
        console.error(`[Pipeline] Failed to check deployed commit for "${queued.request.stack}":`, err);
        return null;
      });
    if (!latest) return null;
    if (latest.commitSha === queued.request.commitSha) return latest;
    return latest.createdAt.getTime() >= queued.queuedAt.getTime() ? latest : null;
  }

  private async resolveQueuedMarker(request: DeployRequest, logs: string): Promise<void> {
    try {
      const deployId = await this.deployRepo.failQueuedDeploy(request.stack, request.host, logs);
      if (deployId === null) return;
      await this.deployRepo.notifyStackChange(request.stack, request.host, {
        deployId,
        status: 'failed',
        action: request.action,
        trigger: request.trigger,
        message: logs,
      });
    } catch (err) {
      console.error(`[Pipeline] Failed to resolve queued marker for stack "${request.stack}":`, err);
    }
  }

  private async resolveEnv(request: DeployRequest): Promise<string> {
    if (request.action !== 'deploy' && request.action !== 'update') return '';

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
      const signer = await this.tokenResolver(host);
      const agent = this.agentClientFactory(host.agentUrl, signer);

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
        case 'update':
          result = await agent.update({
            stack: request.stack,
            composeContent: request.composeContent,
            envContent,
          });
          break;
        default: {
          const _exhaustive: never = request;
          throw new Error(`Unknown deploy action: ${(_exhaustive as DeployRequest).action}`);
        }
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
        await this.deployRepo.notifyStackChange(request.stack, host.name, {
          deployId,
          status: 'failed',
          action: request.action,
          trigger: request.trigger,
          message: errorMsg,
        });
      } catch (notifyErr) {
        console.error(`Failed to notify stack change for deploy ${deployId} ("${request.stack}" on "${host.name}"):`, notifyErr);
      }
      await this.drainQueue(request.stack, host.name);
      return { status: 'failed', logs: errorMsg, deployId };
    }

    // Record result outside try: a DB failure here must not be misattributed to the agent
    const finalStatus: DeployStatus = result.success ? 'succeeded' : 'failed';
    try {
      await this.deployRepo.updateStatus(deployId, finalStatus, result.logs);
    } catch (err) {
      console.error(
        `Failed to record deploy ${deployId} result (actual status: ${finalStatus}) for stack "${request.stack}":`,
        err,
      );
    }

    // Post-success hook: runs after status update so a later crash can still
    // recover via startup sweep of rows with postSuccess set.
    // `no_change` is treated as success (teardown of a stack with nothing running).
    const treatAsSuccess = finalStatus === 'succeeded';
    if (treatAsSuccess && request.postSuccess === 'removeFromManifest') {
      try {
        await this.stackRepoWriter.removeStackFromManifest(request.stack);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(
          `[Pipeline] postSuccess manifest delete failed for "${request.stack}":`,
          err,
        );
        try {
          await this.deployRepo.updateStatus(
            deployId,
            'failed',
            `Teardown succeeded but manifest delete failed: ${errMsg}`,
          );
        } catch (updateErr) {
          console.error('[Pipeline] Failed to record postSuccess failure status:', updateErr);
        }
        try {
          await this.deployRepo.notifyStackChange(request.stack, host.name, {
            deployId,
            status: 'failed',
            action: request.action,
            trigger: request.trigger,
            message: errMsg,
          });
        } catch (notifyErr) {
          console.error(`Failed to notify stack change for "${request.stack}":`, notifyErr);
        }
        await this.drainQueue(request.stack, host.name);
        return { status: 'failed', logs: errMsg, deployId };
      }
    }

    try {
      await this.deployRepo.notifyStackChange(request.stack, host.name, {
        deployId,
        status: finalStatus,
        action: request.action,
        trigger: request.trigger,
        ...(finalStatus === 'failed' ? { message: result.logs } : {}),
      });
    } catch (err) {
      console.error(`Failed to notify stack change for "${request.stack}":`, err);
    }

    await this.drainQueue(request.stack, host.name);

    return { status: finalStatus, logs: result.logs, deployId };
  }
}

const ACTIVE_DEPLOY_NOUNS: Record<DeployRequest['action'], string> = {
  deploy: 'a deploy',
  update: 'an image update',
  teardown: 'a teardown',
};

function formatElapsed(since: Date): string {
  const seconds = Math.max(0, Math.round((Date.now() - since.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}

/**
 * Merge existing env content with resolved secrets.
 * Secrets are appended to the env content. Existing keys in envContent
 * are NOT overridden by secrets (explicit env takes precedence).
 */
function buildEnvContent(existingEnv: string, secrets: Record<string, string>): string {
  const rawLines = existingEnv ? existingEnv.split('\n').filter(l => l.trim()) : [];

  // Sanitize each existing env line to strip embedded control characters.
  // Comment lines and lines without '=' are passed through untouched.
  const lines = rawLines.map(line => {
    if (line.startsWith('#') || !line.includes('=')) return line;
    const eqIdx = line.indexOf('=');
    const key = line.slice(0, eqIdx).trim();
    const rawValue = line.slice(eqIdx + 1);
    // Strip trailing CR/LF before checking quotes so values like FOO="bar"\r
    // still get their outer quotes stripped (intentional trailing spaces preserved).
    const valueForQuoteCheck = rawValue.replace(/[\r\n]+$/, '');
    const hasMatchingQuotes =
      (valueForQuoteCheck.startsWith("'") && valueForQuoteCheck.endsWith("'")) ||
      (valueForQuoteCheck.startsWith('"') && valueForQuoteCheck.endsWith('"'));
    const unquoted = hasMatchingQuotes ? valueForQuoteCheck.slice(1, -1) : valueForQuoteCheck;
    const sanitized = unquoted.replaceAll(/[\r\n\0]/g, '').replaceAll("'", "'\\''");
    return `${key}='${sanitized}'`;
  });

  const existingKeys = new Set(
    lines
      .filter(l => l.includes('=') && !l.startsWith('#'))
      .map(l => l.split('=')[0].trim())
  );

  for (const [key, value] of Object.entries(secrets)) {
    if (!existingKeys.has(key)) {
      const sanitized = value.replaceAll(/[\r\n\0]/g, '').replaceAll("'", "'\\''");
      lines.push(`${key}='${sanitized}'`);
    }
  }

  return lines.join('\n');
}
