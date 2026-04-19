/**
 * Pure dispatcher for the delete-stack decision. Extracted from stack-service
 * so unit tests can import it without being affected by other tests that mock
 * the `stack-service` module.
 */

export type DeleteStackResult =
  | { status: 'removed'; commitSha: string }
  | { status: 'teardown-pending'; deployId: number };

export interface DeleteStackDeps {
  triggerDeploy: (params: {
    stack: string;
    host: string;
    action: 'teardown';
    postSuccess: 'removeFromManifest';
  }) => Promise<{ deployId: number }>;
  commitRemoveFromManifest: (stackName: string) => Promise<{ commitSha: string }>;
}

export async function resolveDeleteStack(
  stackName: string,
  host: string,
  teardown: boolean,
  deps: DeleteStackDeps,
): Promise<DeleteStackResult> {
  if (teardown) {
    const { deployId } = await deps.triggerDeploy({
      stack: stackName,
      host,
      action: 'teardown',
      postSuccess: 'removeFromManifest',
    });
    return { status: 'teardown-pending', deployId };
  }
  const { commitSha } = await deps.commitRemoveFromManifest(stackName);
  return { status: 'removed', commitSha };
}
