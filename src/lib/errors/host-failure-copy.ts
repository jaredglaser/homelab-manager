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

/** The codes a host row can carry. The CHECK in migration 045 lists the same members, so a new one needs a migration. */
export const HOST_PROBE_FAILURE_CODES = [
  'offline',
  'unreachable',
  'awaiting-enrollment',
  'agent-unhealthy',
  'certificate-rejected',
  'health_check_failed',
] as const satisfies readonly (AgentHealthFailureReason | 'health_check_failed')[];

/** The probe's detail is raw error text, so it is cut before it is stored and broadcast to every viewer. */
export const MAX_FAILURE_DETAIL_LENGTH = 512;

export type HostProbeFailureCode = (typeof HOST_PROBE_FAILURE_CODES)[number];

export function probeFailureCode(outcome: { reason?: HostProbeFailureCode }): HostProbeFailureCode {
  return outcome.reason ?? 'health_check_failed';
}

export interface HostFailureCopy {
  /** What went wrong, in the operator's terms. */
  headline: string;
  /** The next action, named concretely. */
  fix: string;
  /** True when the underlying detail carries the diagnosis, so it is worth showing. */
  includeDetail: boolean;
}

/**
 * The one place a host failure code becomes what the operator reads. The service's own message carries
 * the diagnosis, and the codes whose copy already names the cause hide it.
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
    fix: 'Enroll a certificate for this host, then check again.',
    includeDetail: false,
  },
  'agent-unhealthy': {
    headline: 'The agent answered but reports that it is unhealthy, because it can reach neither Docker nor ZFS.',
    fix: 'Check that the Docker socket or daemon on the agent host is running and mounted into the agent container, then check again.',
    includeDetail: false,
  },
  'certificate-rejected': {
    headline: "The manager rejected the agent's TLS certificate: it does not match the pinned one, has expired, or does not cover the host name in the URL.",
    fix: 'If the URL uses an address the certificate does not cover, change it to a host name the certificate does cover. Otherwise follow the agent TLS recovery steps in the self-hosting guide to enroll a fresh certificate, then check again.',
    includeDetail: true,
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
    fix: "Rotate this host's keypair, or remove and re-add the host.",
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
    fix: 'Correct the cause on the agent host, then retry the update.',
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

export function hostFailureDetail(code: HostFailureCode, detail?: string): string | null {
  return HOST_FAILURE_COPY[code].includeDetail && detail ? detail : null;
}

/** The sentence the operator reads. Never names a control: the surface owns which button it offers. */
export function hostFailureMessage(code: HostFailureCode, detail?: string): string {
  const copy = HOST_FAILURE_COPY[code];
  const parts = [copy.headline, copy.fix];
  const shown = hostFailureDetail(code, detail);
  if (shown) parts.push(shown);
  return parts.join(' ');
}

