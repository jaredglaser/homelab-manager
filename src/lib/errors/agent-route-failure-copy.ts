import {
  isAgentUpdateFailureCode,
  type AgentRouteFailureCode,
  type AgentUpdateFailureCode,
} from '@homelab-manager/agent/types';
import {
  composeFailureMessage,
  hostFailureMessage,
  type HostFailureCode,
  type HostFailureCopy,
} from '@/lib/errors/host-failure-copy';

const AGENT_ROUTE_FAILURE_COPY: Record<AgentRouteFailureCode, HostFailureCopy> = {
  invalid_json: {
    headline: 'The agent could not read what the manager sent.',
    fix: 'Run the operation again. If it repeats, check for a proxy between the manager and the agent that changes what is sent, then report it as a manager bug.',
    includeDetail: false,
  },
  invalid_request_body: {
    headline: 'The manager sent the agent something it could not use.',
    fix: 'Run the operation again. If it repeats, report it as a manager bug, since nothing on the host needs changing.',
    includeDetail: false,
  },
  invalid_stack_name: {
    headline:
      'The stack name was rejected. A stack name must start with a letter or a digit and use only letters, digits, hyphens and underscores.',
    fix: 'Rename the stack to match, then run the operation again.',
    includeDetail: false,
  },
  invalid_service_name: {
    headline:
      'The service name was rejected. A service name must start with a letter or a digit and use only letters, digits, dots, hyphens and underscores.',
    fix: 'Correct the service name in the compose file, then run the operation again.',
    includeDetail: false,
  },
  missing_stack_field: {
    headline: 'The manager asked the agent to act on a stack without saying which one.',
    fix: 'Report this as a manager bug. Running the operation again cannot help.',
    includeDetail: false,
  },
  missing_service_field: {
    headline: 'The manager asked the agent to act on a single service without saying which one.',
    fix: 'Report this as a manager bug. Running the operation again cannot help.',
    includeDetail: false,
  },
  invalid_scope: {
    headline: 'The manager asked the agent to act on something that is neither a whole stack nor a single service.',
    fix: 'Report this as a manager bug. Running the operation again cannot help.',
    includeDetail: false,
  },
  invalid_stack_path: {
    headline: "The agent refused to use the stack's folder because it lies outside the agent's stacks directory.",
    fix: 'Report this as a manager bug. Nothing on the host needs changing.',
    includeDetail: false,
  },
  stack_not_found: {
    headline: 'The agent has no stack with that name.',
    fix: 'If the stack was never deployed to this host, deploy it first, and there is nothing to remove. Otherwise check that its folder and docker-compose.yml are in the stacks directory on the agent host.',
    includeDetail: false,
  },
  compose_spawn_failed: {
    headline: 'The agent could not start docker compose for this stack.',
    fix: 'Check that docker compose is installed on the agent host and that the agent can run it, then run the operation again.',
    includeDetail: true,
  },
  stack_write_failed: {
    headline: "The agent could not write the stack's files to disk.",
    fix: 'Check free space and write permission on the stacks directory on the agent host, then run the operation again.',
    includeDetail: true,
  },
  missing_deploy_fields: {
    headline: 'The agent was asked to deploy a stack with no name or an empty compose file.',
    fix: "If the stack's compose file is empty, add its contents and deploy again. Otherwise report this as a manager bug.",
    includeDetail: false,
  },
  invalid_deploy_fields: {
    headline: 'The manager sent the agent a stack name or compose file in a form it could not use.',
    fix: 'Report this as a manager bug. Running the deploy again cannot help.',
    includeDetail: false,
  },
  invalid_env_content: {
    headline: 'The manager sent the agent the stack environment variables in a form it could not use.',
    fix: 'Report this as a manager bug. Running the deploy again cannot help.',
    includeDetail: false,
  },
  invalid_force_recreate: {
    headline: 'The manager sent the agent a recreate setting in a form it could not use.',
    fix: 'Report this as a manager bug. Running the deploy again cannot help.',
    includeDetail: false,
  },
  compose_too_large: {
    headline: 'The compose file is larger than the agent accepts.',
    fix: 'Shorten the compose file or split the stack into smaller stacks, then deploy again.',
    includeDetail: false,
  },
  env_too_large: {
    headline: 'The environment variables for this stack are larger than the agent accepts.',
    fix: 'Remove unused variables or move large values out of them, then deploy again.',
    includeDetail: false,
  },
  stacks_dir_unreadable: {
    headline: 'The agent could not read its stacks directory.',
    fix: 'Check that the stacks directory on the agent host is a folder the agent has permission to read, then run the operation again.',
    includeDetail: true,
  },
  compose_read_failed: {
    headline: "The agent could not read this stack's compose file.",
    fix: 'Check that the compose file on the agent host is a file the agent has permission to read, then run the operation again.',
    includeDetail: true,
  },
  update_docker_unavailable: {
    headline: 'This agent cannot update itself because it has no Docker access.',
    fix: 'Update it by hand on the agent host. Run docker compose pull and docker compose up -d in the agent stack directory.',
    includeDetail: false,
  },
  update_request_invalid: {
    headline: 'The agent could not read what the manager sent for this update.',
    fix: 'Run the update again. If it repeats, check for a proxy between the manager and the agent that changes what is sent, then report it as a manager bug.',
    includeDetail: false,
  },
  update_target_not_pinned: {
    headline: 'The agent rejected the image the manager asked it to update to.',
    fix: 'The manager chooses that image itself, so the manager and this agent disagree, or something between them changed what was sent. Check for a proxy between them, report this as a manager bug, and update the agent by hand on its host in the meantime.',
    includeDetail: false,
  },
  update_target_repo_mismatch: {
    headline: 'This agent runs from a different image repository than the one the manager updates agents from.',
    fix: 'Update this agent by hand on its host from the image it runs from, or redeploy it from the image repository the manager uses.',
    includeDetail: false,
  },
  update_in_progress: {
    headline: 'The agent started an update recently and is not accepting another yet.',
    fix: 'That update may have failed. Wait a few minutes, or restart the agent container on its host, then run the update again.',
    includeDetail: false,
  },
  update_start_failed: {
    headline: 'The agent was unable to begin updating itself.',
    fix: 'Check that the agent is configured with the name of its own container and that its Docker connection allows it to inspect, create and start containers, then run the update again.',
    includeDetail: true,
  },
  container_not_found: {
    headline: 'The container no longer exists on this host.',
    fix: 'Refresh the container list, then run the operation on a container that still exists.',
    includeDetail: false,
  },
  container_state_unchanged: {
    headline: 'Docker refused the action, possibly because the container was already in the state the operation asked for.',
    fix: 'Refresh the container list to see its current state, and act on it again only if it still differs.',
    includeDetail: true,
  },
  container_control_failed: {
    headline: 'Docker could not carry out the action on the container.',
    fix: 'Fix the cause that Docker reports on the agent host, then run the operation again.',
    includeDetail: true,
  },
  zfs_unavailable: {
    headline: 'ZFS is not available on this agent host.',
    fix: 'Make sure the ZFS tools are installed where the agent runs and restart the agent. If this host has no ZFS pools, stop collecting ZFS data from it.',
    includeDetail: false,
  },
};

export function agentRouteFailureCopy(code: AgentRouteFailureCode): HostFailureCopy {
  return AGENT_ROUTE_FAILURE_COPY[code];
}

export function agentRouteOperatorMessage(code: AgentRouteFailureCode, detail?: string): string {
  return composeFailureMessage(AGENT_ROUTE_FAILURE_COPY[code], detail);
}

export type UpdateFailureCode = HostFailureCode | AgentUpdateFailureCode;

type AssertDisjoint<T extends never> = T;
// Fails to compile when a host failure code is named like an agent update code, which would send it to the wrong copy.
export type HostAndUpdateCodesAreDisjoint = AssertDisjoint<Extract<HostFailureCode, AgentUpdateFailureCode>>;

export function updateFailureMessage(code: UpdateFailureCode, detail?: string): string {
  return isAgentUpdateFailureCode(code) ? agentRouteOperatorMessage(code, detail) : hostFailureMessage(code, detail);
}
