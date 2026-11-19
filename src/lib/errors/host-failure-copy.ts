import type { AgentHealthFailureReason } from '@/lib/services/agent-health-service';

/**
 * Why a host health check or agent update failed. The probe's own reasons are promoted as-is so its
 * classification reaches the UI unchanged. An expected failure travels as a code, and only a bug throws.
 */
export type HostFailureCode =
  | AgentHealthFailureReason
  | 'health_check_failed'
  | 'image_digest_unresolved'
  | 'keypair_unavailable'
  | 'token_signing_failed'
  | 'agent_unreachable'
  | 'unexpected_redirect'
  | 'agent_reported_error'
  | 'update_interrupted'
  | 'restart_unconfirmed'
  | 'version_unconfirmed'
  | 'agent_did_not_restart';

export interface HostFailureCopy {
  /** What went wrong, in the operator's terms. */
  headline: string;
  /** The next action, named concretely. */
  fix: string;
  /** True when the underlying detail carries the diagnosis, so it is worth showing. */
  includeDetail: boolean;
}

/**
 * The one place a host failure code becomes what the operator reads. The service's own message is the
 * diagnostic layer: it reaches the logs, and the codes whose copy already names the cause hide it.
 */
const HOST_FAILURE_COPY: Record<HostFailureCode, HostFailureCopy> = {
  offline: {
    headline: 'The host did not answer the health check.',
    fix: 'Check that the agent container is running and reachable at the URL stored for this host, then check again.',
    includeDetail: true,
  },
  unreachable: {
    headline: 'Something answered at the host URL, but it is not a healthy agent.',
    fix: 'Check that the URL stored for this host points at the agent, then check again.',
    includeDetail: true,
  },
  'awaiting-enrollment': {
    headline: 'The agent is serving plain HTTP because it holds no certificate yet.',
    fix: 'Enroll a certificate for this host from its row in the Managed Hosts card, then check again.',
    includeDetail: false,
  },
  health_check_failed: {
    headline: 'The host health check did not pass.',
    fix: 'Check the agent logs, then check again.',
    includeDetail: true,
  },
  image_digest_unresolved: {
    headline: 'The manager could not resolve the agent image digest from the registry.',
    fix: 'Check that the manager can reach the image registry, then retry the update.',
    includeDetail: false,
  },
  keypair_unavailable: {
    headline: 'The manager has no keypair for this host, so it cannot sign the update request.',
    fix: "Rotate the keypair from this host's keypair dialog, or remove and re-add the host.",
    includeDetail: false,
  },
  token_signing_failed: {
    headline: 'The manager could not sign the update request.',
    fix: 'Check the manager logs, then retry the update.',
    includeDetail: true,
  },
  agent_unreachable: {
    headline: 'The manager could not reach the agent to start the update.',
    fix: 'Check that the agent container is running and listening on the URL stored for this host, then retry.',
    includeDetail: true,
  },
  unexpected_redirect: {
    headline: 'The agent URL returned an unexpected redirect.',
    fix: 'Point this host at the agent directly, with no proxy or redirect in front of it, then retry.',
    includeDetail: false,
  },
  agent_reported_error: {
    headline: 'The agent refused the update.',
    fix: 'Read the agent message below, correct the cause on the agent host, then retry.',
    includeDetail: true,
  },
  update_interrupted: {
    headline: 'The agent is still running its previous image, so the update did not complete.',
    fix: 'Retry the update, and restart the agent container on the host if it repeats.',
    includeDetail: false,
  },
  restart_unconfirmed: {
    headline: 'The agent stayed reachable throughout the update window, so its restart could not be confirmed.',
    fix: 'Restart the agent container on the host, then check the agent version.',
    includeDetail: false,
  },
  version_unconfirmed: {
    headline: 'The agent is reachable but reported no version, so the update could not be confirmed.',
    fix: 'Check the agent version on the host, then retry the update if it did not change.',
    includeDetail: false,
  },
  agent_did_not_restart: {
    headline: 'The agent did not come back after the update.',
    fix: 'Check that the agent container is running on the host, then retry the update.',
    includeDetail: true,
  },
};

/** The sentence the operator reads. Never names a control: the surface owns which button it offers. */
export function hostFailureMessage(code: HostFailureCode, detail?: string): string {
  const copy = HOST_FAILURE_COPY[code];
  const parts = [copy.headline, copy.fix];
  if (copy.includeDetail && detail) parts.push(detail);
  return parts.join(' ');
}
