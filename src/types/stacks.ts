/** Summary returned when listing all stacks. */
export interface StackSummary {
  name: string;
  iconSlug: string | null;
  /** Last deploy status per host. */
  hosts: Array<{
    host: string;
    status: 'synced' | 'drift' | 'pending' | 'failed' | 'unknown';
    lastDeployedAt: string | null;
  }>;
}

/** Full detail for a single stack. */
export interface StackDetail {
  name: string;
  iconSlug: string | null;
  composeContent: string;
  variables: Record<string, string>;
  hosts: StackSummary['hosts'];
}

/** A single deploy history record. */
export interface DeployRecord {
  id: number;
  stackName: string;
  host: string;
  action: 'deploy' | 'teardown' | 'restart';
  status: 'pending' | 'running' | 'success' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}
