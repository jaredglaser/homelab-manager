import type { DeployRequest, Manifest } from '@/lib/deploy/types';

interface GitTriggerInput {
  manifest: Manifest;
  /** Map of stack name -> compose file content for stacks with changed files */
  changedStacks: Map<string, string>;
  commitSha: string;
}

/**
 * Builds DeployRequests from a git push event.
 * Receives the set of changed stacks (determined by the git diff)
 * and the manifest. Produces one DeployRequest per changed stack
 * that exists in the manifest.
 */
export class GitTriggerBuilder {
  build(input: GitTriggerInput): DeployRequest[] {
    const requests: DeployRequest[] = [];

    for (const [stackName, composeContent] of input.changedStacks) {
      const manifestEntry = input.manifest.stacks[stackName];
      if (!manifestEntry) continue;

      requests.push({
        stack: stackName,
        host: manifestEntry.host,
        composeContent,
        commitSha: input.commitSha,
        envContent: '',
        action: 'deploy',
        trigger: 'git_push',
        autoApproved: manifestEntry.autoDeploy,
      });
    }

    return requests;
  }
}
