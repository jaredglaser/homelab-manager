import {
  AGENT_ROUTE_FAILURE_CODES,
  type AgentRouteFailureCode,
} from '@homelab-manager/agent/types';

export interface AgentRouteFailureCopy {
  /** What went wrong, in the operator's terms. */
  headline: string;
  /** The next action, named concretely. */
  fix: string;
  /** True when the underlying detail carries the diagnosis, so it is worth showing. */
  includeDetail: boolean;
}

/**
 * The one place an agent route failure code becomes what the operator reads. The agent's own sentence
 * carries the diagnosis, and the codes whose copy already names the cause hide it.
 */
const AGENT_ROUTE_FAILURE_COPY: Record<AgentRouteFailureCode, AgentRouteFailureCopy> = {
  invalid_json: {
    headline: 'The agent could not read the request it was sent as JSON.',
    fix: 'Run the operation again, and report the detail below if it repeats. Nothing on the host needs changing.',
    includeDetail: true,
  },
  invalid_request_body: {
    headline: 'The agent received a request body that was not a JSON object.',
    fix: 'Run the operation again. If it repeats, report it as a manager bug, since the host is not at fault.',
    includeDetail: false,
  },
  invalid_stack_name: {
    headline:
      'The stack name was rejected. A stack name must start with a letter or a digit and use only letters, digits, hyphens and underscores.',
    fix: 'Rename the stack to match that pattern, then run the operation again.',
    includeDetail: false,
  },
  invalid_service_name: {
    headline:
      'The service name was rejected. A service name must start with a letter or a digit and use only letters, digits, dots, hyphens and underscores.',
    fix: 'Correct the service name in the compose file, then run the operation again.',
    includeDetail: false,
  },
  missing_stack_field: {
    headline: 'The agent was asked to act on a stack without being told which stack.',
    fix: 'Report this as a manager bug. The request was built without a stack name, so running it again alone cannot help.',
    includeDetail: false,
  },
  missing_service_field: {
    headline: 'A service-scoped operation reached the agent without a service name.',
    fix: 'Report this as a manager bug. The request named the scope but not the service it applies to.',
    includeDetail: false,
  },
  invalid_scope: {
    headline:
      'The agent was sent a scope it does not recognise, so it could not tell whether to act on a stack or on a service.',
    fix: 'Report this as a manager bug. The scope has to be either a stack or a service.',
    includeDetail: false,
  },
  invalid_stack_path: {
    headline:
      'The agent refused the stack path because it points outside the directory the agent reads stacks from.',
    fix: 'Report this as a manager bug. The stack name was turned into a path the agent will not open.',
    includeDetail: false,
  },
  stack_not_found: {
    headline: 'The agent has no stack with the name it was given.',
    fix: 'Check the stack name against the stacks directory on the agent host, then run the operation again.',
    includeDetail: true,
  },
  compose_spawn_failed: {
    headline: 'The agent could not run docker compose for this stack.',
    fix: 'Read the error below, check that docker compose is installed and runnable by the agent on its host, then run the operation again.',
    includeDetail: true,
  },
  stack_write_failed: {
    headline: 'The agent could not write the stack files to disk.',
    fix: 'Read the error below, check free space and write permission on the agent host, then run the operation again.',
    includeDetail: true,
  },
  missing_deploy_fields: {
    headline: 'The agent was asked to deploy without a stack name or compose content.',
    fix: 'Report this as a manager bug. The deploy request left out a field it has to carry.',
    includeDetail: false,
  },
  invalid_deploy_fields: {
    headline: 'The agent was sent a deploy whose stack name or compose content was not text.',
    fix: 'Report this as a manager bug. The deploy request carried a field with the wrong type.',
    includeDetail: false,
  },
  invalid_env_content: {
    headline: 'The agent was sent environment content that was not text.',
    fix: 'Report this as a manager bug. The environment content in the deploy request had the wrong type.',
    includeDetail: false,
  },
  invalid_force_recreate: {
    headline: 'The agent was sent a force-recreate flag that was neither on nor off.',
    fix: 'Report this as a manager bug. The deploy request carried the wrong type for the force-recreate flag.',
    includeDetail: false,
  },
  compose_too_large: {
    headline: 'The compose content is larger than the agent accepts.',
    fix: 'Trim the compose file or split the stack into smaller ones, then deploy again.',
    includeDetail: false,
  },
  env_too_large: {
    headline: 'The environment content is larger than the agent accepts.',
    fix: 'Trim the environment content for this stack, then deploy again.',
    includeDetail: false,
  },
  stacks_dir_unreadable: {
    headline: 'The agent could not read its stacks directory.',
    fix: 'Read the error below, check that the stacks directory exists and is readable on the agent host, then run the operation again.',
    includeDetail: true,
  },
  compose_read_failed: {
    headline: "The agent could not read this stack's compose file.",
    fix: "Read the error below, check the file's permission on the agent host, then run the operation again.",
    includeDetail: true,
  },
  update_docker_unavailable: {
    headline: 'This agent cannot update itself because it has no Docker capability.',
    fix: 'Update it by hand on the agent host. Run docker compose pull and docker compose up -d in the agent stack directory.',
    includeDetail: false,
  },
  update_request_invalid: {
    headline: 'The agent could not read the update request it was sent.',
    fix: 'Run the update again. If it repeats, check for a proxy between the manager and the agent that alters requests, then report it as a manager bug.',
    includeDetail: false,
  },
  update_target_not_pinned: {
    headline: 'The agent did not accept the image reference the manager sent for this update.',
    fix: 'The manager always sends a pinned image, so the manager and this agent disagree about the format. Report this as a manager bug, and update the agent by hand on its host in the meantime.',
    includeDetail: false,
  },
  update_target_repo_mismatch: {
    headline: 'This agent runs from a different image repository than the one the manager updates agents from.',
    fix: 'Update this agent by hand on its host from the image it runs from, or redeploy it from the image repository the manager uses.',
    includeDetail: false,
  },
  update_in_progress: {
    headline: 'The agent is already running an update.',
    fix: 'Wait for the running update to finish, then run the update again if it did not take.',
    includeDetail: false,
  },
  update_start_failed: {
    headline: 'The agent could not start its update.',
    fix: 'Read the error below, check that the agent can create and start containers through its Docker connection, then run the update again.',
    includeDetail: true,
  },
  container_not_found: {
    headline: 'The agent has no container with the id it was given.',
    fix: 'Reload the container list, then run the operation on a container that still exists.',
    includeDetail: true,
  },
  container_state_unchanged: {
    headline: 'The container was already in the state the operation asked for, so the agent changed nothing.',
    fix: "Check the container's current state, then act on it only if it differs from what you asked for.",
    includeDetail: true,
  },
  container_control_failed: {
    headline: 'The agent could not carry out the container action.',
    fix: 'Read the error below, check that the container is still present and that the agent can reach Docker, then run the operation again.',
    includeDetail: true,
  },
  zfs_unavailable: {
    headline: 'ZFS is not available on this agent host.',
    fix: 'Install and load ZFS on the host, or leave this host alone if it has no ZFS pools.',
    includeDetail: false,
  },
  zfs_pool_list_failed: {
    headline: 'The agent could not list the ZFS pools on its host.',
    fix: 'Check the agent logs for the pool error, then run the operation again.',
    includeDetail: false,
  },
};

export function agentRouteFailureCopy(code: AgentRouteFailureCode): AgentRouteFailureCopy {
  return AGENT_ROUTE_FAILURE_COPY[code];
}

/** Narrows a code an agent sent, so a code this manager does not know keeps the generic refusal copy. */
export function isAgentRouteFailureCode(value: unknown): value is AgentRouteFailureCode {
  return typeof value === 'string' && (AGENT_ROUTE_FAILURE_CODES as readonly string[]).includes(value);
}

/** The sentence the operator reads. Never names a control: the surface owns which button it offers. */
export function agentRouteFailureMessage(code: AgentRouteFailureCode, detail?: string): string {
  const copy = AGENT_ROUTE_FAILURE_COPY[code];
  const parts = [copy.headline, copy.fix];
  if (copy.includeDetail && detail) parts.push(detail);
  return parts.join(' ');
}
