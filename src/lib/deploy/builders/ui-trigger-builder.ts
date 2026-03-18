import type { DeployAction, DeployRequest } from '@/lib/deploy/types';

interface UITriggerInput {
  stack: string;
  host: string;
  composeContent: string;
  commitSha: string;
  action: DeployAction;
}

interface UIRollbackInput {
  stack: string;
  host: string;
  composeContent: string;
  commitSha: string;
}

/**
 * Builds a DeployRequest from a UI action.
 * UI deploys are always auto-approved (the user clicked the button).
 */
export class UITriggerBuilder {
  /** Workaround: explicit constructor so Bun counts it in function coverage (oven-sh/bun#7025) */
  constructor() {}
  build(input: UITriggerInput): DeployRequest {
    const base = {
      stack: input.stack,
      host: input.host,
      commitSha: input.commitSha,
      trigger: 'ui' as const,
      autoApproved: true,
    };
    if (input.action === 'deploy') {
      return { ...base, action: 'deploy', composeContent: input.composeContent, envContent: '' };
    }
    return { ...base, action: input.action };
  }

  buildRollback(input: UIRollbackInput): DeployRequest {
    return {
      stack: input.stack,
      host: input.host,
      composeContent: input.composeContent,
      commitSha: input.commitSha,
      envContent: '',
      action: 'deploy',
      trigger: 'manual_rollback',
      autoApproved: true,
    };
  }
}
