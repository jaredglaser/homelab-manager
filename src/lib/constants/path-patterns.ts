/** Stack names. Must start alphanumeric; mirrors the agent's VALID_STACK_NAME, which rejects anything else at deploy time. */
export const STACK_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** Path segments that must not escape their directory. Deliberately looser than STACK_NAME_PATTERN: env var names may lead with an underscore. */
export const SAFE_PATH_SEGMENT_PATTERN = /^[a-zA-Z0-9_-]+$/;
