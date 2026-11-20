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
});
