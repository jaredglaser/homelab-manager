import { describe, it, expect } from 'bun:test';
import {
  AGENT_ROUTE_FAILURE_CODES,
  AGENT_UPDATE_FAILURE_CODES,
  isAgentRouteFailureCode,
  isAgentUpdateFailureCode,
  type AgentRouteFailureCode,
} from '@homelab-manager/agent/types';
import { agentRouteFailureCopy, agentRouteOperatorMessage, updateFailureMessage } from '../agent-route-failure-copy';
import { HOST_PROBE_FAILURE_CODES, hostFailureMessage } from '../host-failure-copy';

describe('agentRouteFailureCopy', () => {
  it('has copy for every code, so a new code cannot ship without a sentence', () => {
    for (const code of AGENT_ROUTE_FAILURE_CODES) {
      expect(agentRouteFailureCopy(code).headline.length).toBeGreaterThan(0);
      expect(agentRouteFailureCopy(code).fix.length).toBeGreaterThan(0);
    }
  });

  it('appends the detail on the codes that carry the diagnosis and drops it on the rest', () => {
    const sentinel = 'zz-detail-sentinel-9f3a';
    const detailCodes = AGENT_ROUTE_FAILURE_CODES.filter((code) => agentRouteFailureCopy(code).includeDetail);
    const otherCodes = AGENT_ROUTE_FAILURE_CODES.filter((code) => !agentRouteFailureCopy(code).includeDetail);
    // Both classes have members, so neither branch below passes vacuously.
    expect(detailCodes.length).toBeGreaterThan(0);
    expect(otherCodes.length).toBeGreaterThan(0);
    for (const code of detailCodes) {
      expect(agentRouteOperatorMessage(code, sentinel)).toContain(sentinel);
    }
    for (const code of otherCodes) {
      expect(agentRouteOperatorMessage(code, sentinel)).not.toContain(sentinel);
    }
  });

  it('narrows route codes and update codes separately, so an unknown code stays generic', () => {
    for (const code of AGENT_UPDATE_FAILURE_CODES) {
      expect(isAgentUpdateFailureCode(code)).toBe(true);
      expect(isAgentRouteFailureCode(code)).toBe(true);
    }
    expect(isAgentUpdateFailureCode('stack_not_found')).toBe(false);
    expect(isAgentUpdateFailureCode('zfs_unavailable')).toBe(false);
    expect(isAgentUpdateFailureCode('agent_reported_error')).toBe(false);
    expect(isAgentUpdateFailureCode(undefined)).toBe(false);
    expect(isAgentRouteFailureCode('not_a_route_code')).toBe(false);
    expect(isAgentRouteFailureCode(42)).toBe(false);
  });

  it('pins what the operator reads for every route code, with the agent detail where the copy shows it', () => {
    const detail = 'agent detail sentence';
    const expected: Record<AgentRouteFailureCode, string> = {
      invalid_json:
        'The agent could not read what the manager sent. Run the operation again. If it repeats, check for a proxy between the manager and the agent that changes what is sent, then report it as a manager bug.',
      invalid_request_body:
        'The manager sent the agent something it could not use. Run the operation again. If it repeats, report it as a manager bug, since nothing on the host needs changing.',
      invalid_stack_name:
        'The stack name was rejected. A stack name must start with a letter or a digit and use only letters, digits, hyphens and underscores. Rename the stack to match, then run the operation again.',
      invalid_service_name:
        'The service name was rejected. A service name must start with a letter or a digit and use only letters, digits, dots, hyphens and underscores. Correct the service name in the compose file, then run the operation again.',
      missing_stack_field:
        'The manager asked the agent to act on a stack without saying which one. Report this as a manager bug. Running the operation again cannot help.',
      missing_service_field:
        'The manager asked the agent to act on a single service without saying which one. Report this as a manager bug. Running the operation again cannot help.',
      invalid_scope:
        'The manager asked the agent to act on something that is neither a whole stack nor a single service. Report this as a manager bug. Running the operation again cannot help.',
      invalid_stack_path:
        `The agent refused to use the stack's folder because it lies outside the agent's stacks directory. Report this as a manager bug. Nothing on the host needs changing.`,
      stack_not_found:
        'The agent has no stack with that name. If the stack was never deployed to this host, deploy it first, and there is nothing to remove. Otherwise check that its folder and docker-compose.yml are in the stacks directory on the agent host.',
      compose_spawn_failed: `The agent could not start docker compose for this stack. Check that docker compose is installed on the agent host and that the agent can run it, then run the operation again. ${detail}`,
      stack_write_failed: `The agent could not write the stack's files to disk. Check free space and write permission on the stacks directory on the agent host, then run the operation again. ${detail}`,
      missing_deploy_fields:
        `The agent was asked to deploy a stack with no name or an empty compose file. If the stack's compose file is empty, add its contents and deploy again. Otherwise report this as a manager bug.`,
      invalid_deploy_fields:
        'The manager sent the agent a stack name or compose file in a form it could not use. Report this as a manager bug. Running the deploy again cannot help.',
      invalid_env_content:
        'The manager sent the agent the stack environment variables in a form it could not use. Report this as a manager bug. Running the deploy again cannot help.',
      invalid_force_recreate:
        'The manager sent the agent a recreate setting in a form it could not use. Report this as a manager bug. Running the deploy again cannot help.',
      compose_too_large:
        'The compose file is larger than the agent accepts. Shorten the compose file or split the stack into smaller stacks, then deploy again.',
      env_too_large:
        'The environment variables for this stack are larger than the agent accepts. Remove unused variables or move large values out of them, then deploy again.',
      stacks_dir_unreadable: `The agent could not read its stacks directory. Check that the stacks directory on the agent host is a folder the agent has permission to read, then run the operation again. ${detail}`,
      compose_read_failed: `The agent could not read this stack's compose file. Check that the compose file on the agent host is a file the agent has permission to read, then run the operation again. ${detail}`,
      update_docker_unavailable:
        'This agent cannot update itself because it has no Docker access. Update it by hand on the agent host. Run docker compose pull and docker compose up -d in the agent stack directory.',
      update_request_invalid:
        'The agent could not read what the manager sent for this update. Run the update again. If it repeats, check for a proxy between the manager and the agent that changes what is sent, then report it as a manager bug.',
      update_target_not_pinned:
        'The agent rejected the image the manager asked it to update to. The manager chooses that image itself, so the manager and this agent disagree, or something between them changed what was sent. Check for a proxy between them, report this as a manager bug, and update the agent by hand on its host in the meantime.',
      update_target_repo_mismatch:
        'This agent runs from a different image repository than the one the manager updates agents from. Update this agent by hand on its host from the image it runs from, or redeploy it from the image repository the manager uses.',
      update_in_progress:
        'The agent started an update recently and is not accepting another yet. That update may have failed. Wait a few minutes, or restart the agent container on its host, then run the update again.',
      update_start_failed: `The agent was unable to begin updating itself. Check that the agent is configured with the name of its own container and that its Docker connection allows it to inspect, create and start containers, then run the update again. ${detail}`,
      container_not_found:
        'The container no longer exists on this host. Refresh the container list, then run the operation on a container that still exists.',
      container_state_unchanged: `Docker refused the action, possibly because the container was already in the state the operation asked for. Refresh the container list to see its current state, and act on it again only if it still differs. ${detail}`,
      container_control_failed: `Docker could not carry out the action on the container. Fix the cause that Docker reports on the agent host, then run the operation again. ${detail}`,
      zfs_unavailable:
        'ZFS is not available on this agent host. Make sure the ZFS tools are installed where the agent runs and restart the agent. If this host has no ZFS pools, stop collecting ZFS data from it.',
    };
    for (const code of AGENT_ROUTE_FAILURE_CODES) {
      expect(agentRouteOperatorMessage(code, detail)).toBe(expected[code]);
    }
  });

  it('sends every code /agent/update refuses with through the update dispatcher to the same sentence', () => {
    for (const code of AGENT_UPDATE_FAILURE_CODES) {
      expect(updateFailureMessage(code, 'agent detail sentence')).toBe(agentRouteOperatorMessage(code, 'agent detail sentence'));
    }
  });

  it('sends a host failure code to the host copy', () => {
    expect(updateFailureMessage('agent_reported_error', 'x')).toBe(hostFailureMessage('agent_reported_error', 'x'));
    expect(updateFailureMessage('agent_reported_error', 'x')).toContain('The agent refused the update.');
  });

  it('sends the not-the-agent code to the host copy with the status the update path carries', () => {
    expect(updateFailureMessage('agent_not_answering', 'HTTP 502')).toBe(hostFailureMessage('agent_not_answering', 'HTTP 502'));
    expect(updateFailureMessage('agent_not_answering', 'HTTP 502')).toBe(
      'Something other than the agent answered (HTTP 502). Check that the agent URL points at the agent and that any proxy in front of it is running, then try again.',
    );
  });

  it('sends every probe code to the host copy, with the probe detail where that copy shows it', () => {
    for (const code of HOST_PROBE_FAILURE_CODES) {
      expect(isAgentRouteFailureCode(code)).toBe(false);
      expect(updateFailureMessage(code, 'probe detail')).toBe(hostFailureMessage(code, 'probe detail'));
    }
    expect(updateFailureMessage('certificate-rejected', 'self signed certificate')).toBe(
      "The manager rejected the agent's TLS certificate: it does not match the pinned one, has expired, or does not cover the host name in the URL. If the URL uses an address the certificate does not cover, change it to a host name the certificate does cover. Otherwise follow the agent TLS recovery steps in the self-hosting guide to enroll a fresh certificate, then check again. self signed certificate",
    );
    expect(updateFailureMessage('agent-unhealthy', 'probe detail')).toBe(
      'The agent answered but reports that it is unhealthy, because it can reach neither Docker nor ZFS. Check that the Docker socket or daemon on the agent host is running and mounted into the agent container, then check again.',
    );
  });

  it('never tells the operator to read something below, since the detail is appended inline', () => {
    for (const code of AGENT_ROUTE_FAILURE_CODES) {
      expect(agentRouteOperatorMessage(code)).not.toMatch(/\bbelow\b/);
    }
  });
});
