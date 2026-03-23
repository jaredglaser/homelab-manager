/** Query key for the stacks list. Defined here to avoid circular imports between route and components. */
export const STACKS_QUERY_KEY = ['stacks-list'] as const;

/** Query key for live stack container status (SSE-backed). */
export const STACK_STATUS_QUERY_KEY = ['stack-status'] as const;

/** Query key for stack variable names. */
export const STACK_VARIABLES_QUERY_KEY = ['stack-variables'] as const;
