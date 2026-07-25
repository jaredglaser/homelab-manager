/** Query key for the stacks list. Defined here to avoid circular imports between route and components. */
export const STACKS_QUERY_KEY = ['stacks-list'] as const;

/** Query key for live stack container status (SSE-backed). */
export const STACK_STATUS_QUERY_KEY = ['stack-status'] as const;

/** Query key for stack variable names. */
export const STACK_VARIABLES_QUERY_KEY = ['stack-variables'] as const;

/** Query key prefix for deploy history. Usage: [...DEPLOY_HISTORY_QUERY_KEY, stackName]. */
export const DEPLOY_HISTORY_QUERY_KEY = ['deploy-history'] as const;

export const STACK_DRIFT_QUERY_KEY = ['stack-drift'] as const;
