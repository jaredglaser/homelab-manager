import { describe, it, expect } from 'bun:test';
import { AGENT_ROUTE_FAILURE_CODES } from '@homelab-manager/agent/types';
import {
  agentRouteFailureCopy,
  agentRouteFailureMessage,
  isAgentRouteFailureCode,
} from '../agent-route-failure-copy';

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
      expect(agentRouteFailureMessage(code, sentinel)).toContain(sentinel);
    }
    for (const code of otherCodes) {
      expect(agentRouteFailureMessage(code, sentinel)).not.toContain(sentinel);
    }
  });

  it('narrows only codes this manager knows, so an unrecognised one keeps the generic refusal copy', () => {
    for (const code of AGENT_ROUTE_FAILURE_CODES) {
      expect(isAgentRouteFailureCode(code)).toBe(true);
    }
    expect(isAgentRouteFailureCode('not_a_route_code')).toBe(false);
    expect(isAgentRouteFailureCode(undefined)).toBe(false);
    expect(isAgentRouteFailureCode(42)).toBe(false);
  });

  it('pins what the operator reads for every code /agent/update can refuse with', () => {
    const detail = 'agent detail sentence';
    expect(agentRouteFailureMessage('update_docker_unavailable', detail)).toBe(
      'This agent cannot update itself because it has no Docker capability. Update it by hand on the agent host. Run docker compose pull and docker compose up -d in the agent stack directory.',
    );
    expect(agentRouteFailureMessage('update_request_invalid', detail)).toBe(
      'The agent could not read the update request it was sent. Run the update again. If it repeats, check for a proxy between the manager and the agent that alters requests, then report it as a manager bug.',
    );
    expect(agentRouteFailureMessage('update_target_not_pinned', detail)).toBe(
      'The agent did not accept the image reference the manager sent for this update. The manager always sends a pinned image, so the manager and this agent disagree about the format. Report this as a manager bug, and update the agent by hand on its host in the meantime.',
    );
    expect(agentRouteFailureMessage('update_target_repo_mismatch', detail)).toBe(
      'This agent runs from a different image repository than the one the manager updates agents from. Update this agent by hand on its host from the image it runs from, or redeploy it from the image repository the manager uses.',
    );
    expect(agentRouteFailureMessage('update_in_progress', detail)).toBe(
      'The agent is already running an update. Wait for the running update to finish, then run the update again if it did not take.',
    );
    expect(agentRouteFailureMessage('update_start_failed', detail)).toBe(
      'The agent could not start its update. Read the error below, check that the agent can create and start containers through its Docker connection, then run the update again. agent detail sentence',
    );
  });
});
