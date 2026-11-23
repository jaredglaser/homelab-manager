import { AGENT_IDENTITY_HEADER } from '@homelab-manager/agent/types';

/** A Response as the real agent sends it: stamped with the identity header, which the caller's own headers may override. */
export function agentResponse(body?: BodyInit | null, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has(AGENT_IDENTITY_HEADER)) headers.set(AGENT_IDENTITY_HEADER, '1');
  return new Response(body, { ...init, headers });
}
