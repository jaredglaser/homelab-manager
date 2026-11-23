import { describe, it, expect } from 'bun:test';
import {
  AGENT_ROUTE_FAILURE_CODES,
  AGENT_UPDATE_FAILURE_CODES,
  TLS_FAILURE_CODES,
  isAgentRouteFailureCode,
  isAgentUpdateFailureCode,
  isTlsFailureCode,
} from '../types';

describe('failure code guards', () => {
  it('accept every code in their set and nothing else', () => {
    for (const code of TLS_FAILURE_CODES) expect(isTlsFailureCode(code)).toBe(code !== 'agent_not_answering' && code !== 'unexpected_redirect');
    for (const code of AGENT_ROUTE_FAILURE_CODES) expect(isAgentRouteFailureCode(code)).toBe(true);
    for (const code of AGENT_UPDATE_FAILURE_CODES) expect(isAgentUpdateFailureCode(code)).toBe(true);
    for (const guard of [isTlsFailureCode, isAgentRouteFailureCode, isAgentUpdateFailureCode]) {
      expect(guard('not_a_code')).toBe(false);
      expect(guard(undefined)).toBe(false);
      expect(guard(409)).toBe(false);
    }
  });

  it('keeps the code the manager raises itself out of the codes the agent sends', () => {
    expect(isAgentRouteFailureCode('agent_not_answering')).toBe(false);
    expect(TLS_FAILURE_CODES).toContain('agent_not_answering');
    expect(isTlsFailureCode('agent_not_answering')).toBe(false);
    expect(TLS_FAILURE_CODES).toContain('unexpected_redirect');
    expect(isTlsFailureCode('unexpected_redirect')).toBe(false);
  });

  it('keeps update codes a subset of route codes and route-only codes out of the update set', () => {
    expect(isAgentUpdateFailureCode('stack_not_found')).toBe(false);
    expect(isAgentRouteFailureCode('update_in_progress')).toBe(true);
  });
});
