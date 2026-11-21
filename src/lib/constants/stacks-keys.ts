/** Query key for the stacks list. Defined here to avoid circular imports between route and components. */
export const STACKS_QUERY_KEY = ['stacks-list'] as const;

/** Query key prefix for deploy history. Usage: [...DEPLOY_HISTORY_QUERY_KEY, stackName]. */
export const DEPLOY_HISTORY_QUERY_KEY = ['deploy-history'] as const;

export const STACK_DRIFT_QUERY_KEY = ['stack-drift'] as const;

/** Usage: [...IMAGE_UPDATE_INFO_QUERY_KEY, host, stackName]. */
export const IMAGE_UPDATE_INFO_QUERY_KEY = ['image-update-info'] as const;

/** Usage: [...IMAGE_CHANGELOG_QUERY_KEY, host, stackName, image]. */
export const IMAGE_CHANGELOG_QUERY_KEY = ['image-changelog'] as const;
