import type { AgentRouteErrorBody, AgentRouteFailureCode } from '../types';

/** What a route already holds when a failure happens. Each message names only the field it needs. */
export interface AgentRouteFailureContext {
  /** Upstream text appended verbatim: a subprocess error, a parser message, or a docker one. */
  detail?: string;
  /** Stack name, for the not-found message. */
  stack?: string;
  /** Container id, for the not-found message. */
  container?: string;
}

/**
 * The one place a route failure code becomes the message that travels with it. Codes stay granular
 * so a caller can branch on the reason, and the same code reached from several sites has to read the
 * same everywhere, so the wording lives here instead of at each call site.
 *
 * This is the agent's own sentence, not the operator's copy: the manager owns what the operator reads
 * (src/lib/errors/) and treats this message as the diagnostic layer. Typing the table by the code union
 * makes a new code without a message a compile error.
 */
const AGENT_ROUTE_FAILURE_MESSAGES: Record<AgentRouteFailureCode, (ctx: AgentRouteFailureContext) => string> = {
  invalid_json: ({ detail }) => `Invalid JSON: ${detail}`,
  invalid_request_body: () => 'Request body must be a JSON object',
  invalid_stack_name: () =>
    'Invalid stack name. Must start with alphanumeric and contain only alphanumeric, hyphens, and underscores.',
  invalid_service_name: () =>
    'Invalid service name. Must start with alphanumeric and contain only alphanumeric, dots, hyphens, and underscores.',
  missing_stack_field: () => 'Missing required field: stack',
  missing_service_field: () => 'scope "service" requires a non-empty service field',
  invalid_scope: () => 'scope must be "stack" or "service"',
  invalid_stack_path: () => 'Invalid stack path',
  stack_not_found: ({ stack }) => `Stack '${stack}' not found`,
  compose_spawn_failed: ({ detail }) => `Failed to execute docker compose: ${detail}`,
  stack_write_failed: ({ detail }) => `Failed to write stack files: ${detail}`,
  missing_deploy_fields: () => 'Missing required fields: stack, composeContent',
  invalid_deploy_fields: () => 'Fields stack and composeContent must be strings',
  invalid_env_content: () => 'Field envContent must be a string',
  invalid_force_recreate: () => 'forceRecreate must be a boolean',
  compose_too_large: () => 'composeContent too large',
  env_too_large: () => 'envContent too large',
  stacks_dir_unreadable: ({ detail }) => `Failed to read stacks directory: ${detail}`,
  compose_read_failed: ({ detail }) => `Failed to read compose file: ${detail}`,
  update_docker_unavailable: () =>
    'Agent updates require Docker capability, which this agent does not have. Update it manually: run `docker compose pull && docker compose up -d` in the agent stack directory.',
  update_request_invalid: () => 'Agent update requires a JSON body with a digest-pinned targetImage',
  update_target_not_pinned: () => 'targetImage must be an image reference pinned to a sha256 digest',
  update_target_repo_mismatch: () =>
    'The requested update target does not belong to the image repository this agent runs from',
  update_in_progress: () => 'An update is already in progress',
  update_start_failed: ({ detail }) => `Could not start the agent update: ${detail}`,
  container_not_found: ({ container }) => `Container not found: ${container}`,
  container_state_unchanged: ({ detail }) => detail ?? 'Container already in target state',
  container_control_failed: ({ detail }) => detail ?? 'Internal error',
};

/** The sentence for a failure code. `ctx` carries whatever the message interpolates. */
export function agentRouteFailureMessage(
  code: AgentRouteFailureCode,
  ctx: AgentRouteFailureContext = {},
): string {
  return AGENT_ROUTE_FAILURE_MESSAGES[code](ctx);
}

/** The agent's JSON error body: the human message plus the code that travels with it. */
export function routeErrorBody(
  code: AgentRouteFailureCode,
  ctx: AgentRouteFailureContext = {},
): AgentRouteErrorBody {
  return { error: agentRouteFailureMessage(code, ctx), code };
}
