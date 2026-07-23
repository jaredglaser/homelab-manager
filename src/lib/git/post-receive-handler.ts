import { buildDeployRequests } from '@/lib/git/post-receive';
import { readFileFromRepo } from '@/lib/git/repo';
import { parseManifest } from '@/lib/git/manifest';
import { MANIFEST } from '@/lib/stacks/stack-repo-layout';
import { GitTriggerBuilder } from '@/lib/deploy/builders/git-trigger-builder';
import type { DeployRepository } from '@/lib/database/repositories/deploy-repository';

/**
 * Process a post-receive event after a git push.
 * Diffs the old and new HEAD, builds deploy requests, and dispatches them
 * to the deploy pipeline.
 *
 * @throws {Error} If the manifest is missing from the repo
 * @throws {YAMLException} If the manifest has invalid YAML syntax
 * @throws {ZodError} If the manifest structure doesn't match schema
 */
export async function processPostReceive(
  repoPath: string,
  oldHead: string,
  newHead: string,
  deployRepo?: DeployRepository,
): Promise<void> {
  const postReceiveRequests = await buildDeployRequests(repoPath, oldHead, newHead);

  if (postReceiveRequests.length === 0) {
    return;
  }

  // Read the manifest at newHead to get the authoritative stack config
  const manifestContent = await readFileFromRepo(repoPath, MANIFEST, newHead);
  const manifest = parseManifest(manifestContent);

  // Build a map of stackName -> composeContent for changed stacks.
  const changedStacks = new Map<string, string>();
  for (const req of postReceiveRequests) {
    console.info(
      `[PostReceive] Deploy request: ${req.action} ${req.stack} on ${req.host} (auto=${req.autoApproved})`,
    );
    try {
      const composeContent = await readFileFromRepo(repoPath, req.composePath, newHead);
      changedStacks.set(req.stack, composeContent);
    } catch (err) {
      console.error(
        `[PostReceive] Failed to read compose file for stack "${req.stack}" at ${newHead}:`,
        err,
      );
      if (deployRepo) {
        try {
          await deployRepo.insertDeploy({
            stack: req.stack,
            host: req.host,
            commitSha: req.commitSha,
            composeHash: '',
            envHash: '',
            status: 'failed',
            trigger: 'git_push',
            action: req.action,
          });
        } catch (dbErr) {
          console.error(
            `[PostReceive] Failed to insert failed deploy record for stack "${req.stack}":`,
            dbErr,
          );
        }
      }
    }
  }

  if (changedStacks.size === 0) {
    return;
  }

  // Build pipeline-compatible deploy requests via GitTriggerBuilder
  const builder = new GitTriggerBuilder();
  const deployRequests = builder.build({ manifest, changedStacks, commitSha: newHead });

  if (deployRequests.length === 0) {
    return;
  }

  // Set up pipeline dependencies and dispatch deploy requests.
  // Wrap in try/catch so pipeline failures never propagate; the post-receive
  // hook must always complete so the git push is not blocked.
  try {
    const { createDeployPipeline } = await import('@/lib/deploy/pipeline-factory');
    const { pipeline } = await createDeployPipeline();

    // Group deploys by host: sequential within each host, parallel across hosts
    const byHost = new Map<string, typeof deployRequests>();
    for (const request of deployRequests) {
      const hostRequests = byHost.get(request.host) ?? [];
      hostRequests.push(request);
      byHost.set(request.host, hostRequests);
    }

    await Promise.all(
      [...byHost.values()].map(async (hostRequests) => {
        for (const request of hostRequests) {
          try {
            const result = await pipeline.execute(request);
            console.info(
              `[PostReceive] Deploy pipeline result for "${request.stack}": ${result.status}`,
            );
          } catch (err) {
            console.error(
              `[PostReceive] Deploy pipeline failed for stack "${request.stack}":`,
              err,
            );
          }
        }
      }),
    );
  } catch (err) {
    console.error(
      '[PostReceive] Failed to initialize deploy pipeline:',
      err,
    );
  }
}
