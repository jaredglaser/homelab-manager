import { buildDeployRequests, type DeployRequest } from '@/lib/git/post-receive';

/**
 * Process a post-receive event after a git push.
 * Diffs the old and new HEAD, builds deploy requests, and returns them.
 *
 * TODO: Dispatch to deploy pipeline once wired up.
 * For now it returns the requests for the caller to handle.
 */
export async function processPostReceive(
  repoPath: string,
  oldHead: string,
  newHead: string,
): Promise<DeployRequest[]> {
  const requests = await buildDeployRequests(repoPath, oldHead, newHead);

  // TODO: Dispatch to deploy pipeline
  // For auto-approved requests: send directly to pipeline
  // For manual-approval requests: create pending deploy record in PostgreSQL

  return requests;
}
