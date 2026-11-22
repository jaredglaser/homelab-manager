import { AGENT_IDENTITY_HEADER } from '@homelab-manager/agent/types';
import { MAX_AGENT_FAILURE_BODY_BYTES, readBoundedBodyResult, singleLine } from '@/lib/clients/agent-http';
import { hostFailureMessage } from '@/lib/errors/host-failure-copy';

export const NOT_ANSWERING_BODY_TIMEOUT_MS = 3000;

export type AgentNotAnsweringCode = 'agent_not_answering';

export interface NotAnsweringFailure {
  code: AgentNotAnsweringCode;
  status: number;
  /** The status as the operator reads it, for the surfaces that compose the copy themselves. */
  detail: string;
  message: string;
  /** What answered, single-line and bounded. For the server log only, never the copy. */
  bodyExcerpt: string;
  /** Set when the body read stopped early, so the excerpt is incomplete. A timeout means the peer held the body open. */
  bodyReadFailure?: 'error' | 'timeout';
}

/** The only reader of the identity header: a failure response without it was not sent by the agent. */
export async function readNotAnsweringFailure(response: Response, bodyTimeoutMs = NOT_ANSWERING_BODY_TIMEOUT_MS): Promise<NotAnsweringFailure | null> {
  if (response.headers.has(AGENT_IDENTITY_HEADER)) return null;
  const detail = `HTTP ${response.status}`;
  const body = await readBoundedBodyResult(response, MAX_AGENT_FAILURE_BODY_BYTES, bodyTimeoutMs);
  return {
    code: 'agent_not_answering',
    status: response.status,
    detail,
    message: hostFailureMessage('agent_not_answering', detail),
    bodyExcerpt: singleLine(body.text),
    ...(body.failure ? { bodyReadFailure: body.failure } : {}),
  };
}

export function notAnsweringLogLine(failure: NotAnsweringFailure, where: string): string {
  const cut = failure.bodyReadFailure ? ` (body read ${failure.bodyReadFailure === 'timeout' ? 'timed out' : 'failed'})` : '';
  return `Something other than the agent answered ${where}: ${failure.detail}${cut}: ${failure.bodyExcerpt}`;
}
