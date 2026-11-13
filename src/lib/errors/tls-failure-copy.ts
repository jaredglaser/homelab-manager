import type { TlsFailureCode } from '@homelab-manager/agent/types';

export interface TlsFailureCopy {
  /** What went wrong, in the operator's terms. */
  headline: string;
  /** The next action, named concretely. */
  fix: string;
  /** Runbook anchor, when the fix needs more than one line of explanation. */
  docAnchor?: string;
  /** True when running the same operation again cannot change the outcome. */
  retryUseless: boolean;
  /** True when the underlying detail carries the diagnosis, so it is worth showing. */
  includeDetail: boolean;
}

// One copy for the four ways openssl or the filesystem can fail: the operator's next step is the same.
const CERT_CREATION_FAILED: TlsFailureCopy = {
  headline: 'The agent could not create the certificate.',
  fix: 'Check the agent logs for the openssl or filesystem error, then retry.',
  retryUseless: false,
  includeDetail: true,
};

/**
 * The one place a failure code becomes what the operator reads. Codes stay granular because the code
 * branches on them, and several share a copy when the next step is the same. The service's own message
 * is the diagnostic layer: it reaches the logs, and the flows that have no code mapping.
 */
const TLS_FAILURE_COPY: Record<TlsFailureCode, TlsFailureCopy> = {
  not_configured_for_tls: {
    headline: 'This agent is not configured for TLS, so it cannot serve HTTPS.',
    fix: 'Set TLS_CERT_PATH and TLS_KEY_PATH on the agent service, restart it, then retry.',
    retryUseless: true,
    includeDetail: false,
  },
  invalid_request: {
    headline: 'The agent rejected the enrollment request as malformed.',
    fix: 'This is a manager-side problem rather than anything to fix on the host. Report it with the detail below.',
    retryUseless: true,
    includeDetail: true,
  },
  challenge_expired: {
    headline: 'The enrollment challenge expired before the agent could verify it.',
    fix: 'Retry provisioning. A loaded manager can let the 60 second window lapse.',
    retryUseless: false,
    includeDetail: false,
  },
  signature_invalid: {
    headline:
      "The agent rejected the manager's request: the AGENT_TRUSTED_PUBKEY in the deployed .env does not match this host's keypair, or AGENT_HOST_NAME does not match the host being verified.",
    fix:
      "Deploy the compose and .env from this wizard session together, or copy the current key from this row's keypair dialog into the .env and restart the agent, then re-verify.",
    retryUseless: true,
    includeDetail: false,
  },
  challenge_reused: {
    headline: 'The agent has already accepted this enrollment request.',
    fix: 'Retry provisioning so a fresh challenge is issued.',
    retryUseless: false,
    includeDetail: false,
  },
  key_generation_failed: CERT_CREATION_FAILED,
  key_write_failed: CERT_CREATION_FAILED,
  cert_sign_failed: CERT_CREATION_FAILED,
  cert_write_failed: CERT_CREATION_FAILED,
  restricted_plain_http: {
    headline: 'The agent is serving plain HTTP with its API restricted until a certificate is enrolled.',
    fix: 'Run Rotate TLS from this host to enroll one.',
    retryUseless: false,
    includeDetail: false,
  },
  internal_error: {
    headline: 'The agent hit an internal error.',
    fix: "Check the agent logs, then retry.",
    retryUseless: false,
    includeDetail: true,
  },
  pin_missing: {
    headline: 'The manager has no pinned certificate for this host, and the enrollment could not be completed.',
    fix: 'If the agent is running, remove its certificate files on the agent host, restart it, then run Rotate TLS again.',
    docAnchor: 'agent-tls-recovery-the-manager-lost-it',
    retryUseless: true,
    includeDetail: false,
  },
  agent_unreachable: {
    headline: 'The agent could not be reached.',
    fix: 'Check that its container is running and listening on the URL stored for this host, then retry.',
    retryUseless: false,
    includeDetail: false,
  },
  plaintext_confirmation_required: {
    headline: 'This agent is serving plain HTTP, so the certificate it presents would be accepted on first use.',
    fix: 'Press Rotate TLS again to confirm, then compare the fingerprint it reports with the one the agent prints at startup (docker logs hlm-agent).',
    retryUseless: false,
    includeDetail: false,
  },
  no_cert_returned: {
    headline: 'The agent reported success but returned no certificate.',
    fix: 'Retry provisioning, and check the agent logs if it repeats.',
    retryUseless: false,
    includeDetail: false,
  },
  store_failed: {
    headline: 'The certificate was enrolled but the manager could not save it.',
    fix: 'Check the manager logs and its database, then retry.',
    retryUseless: false,
    includeDetail: true,
  },
  restart_unavailable: {
    headline: 'This agent has no Docker capability, so it cannot restart itself.',
    fix: 'Restart it manually (docker restart hlm-agent on the agent host), then retry provisioning.',
    retryUseless: true,
    includeDetail: false,
  },
  poll_timeout: {
    headline: 'The agent did not serve the new certificate over HTTPS in time.',
    fix: 'Restart it manually (docker restart hlm-agent on the agent host) if it cannot restart itself, then retry provisioning.',
    retryUseless: false,
    includeDetail: true,
  },
  no_keypair: {
    headline: 'The manager has no keypair for this host, so it cannot sign requests to it.',
    fix: "Rotate the keypair from this host's keypair dialog, or remove and re-add the host.",
    retryUseless: true,
    includeDetail: false,
  },
  unexpected_agent_response: {
    headline: 'The agent answered with an error this manager does not recognise.',
    fix: 'Check the agent logs and its version, then retry.',
    retryUseless: false,
    includeDetail: true,
  },
};

export interface TlsFailureGuidance {
  message: string;
  /** Runbook anchor to link, when the fix needs more explanation than the message carries. */
  docAnchor?: string;
}

export function tlsFailureCopy(code: TlsFailureCode): TlsFailureCopy {
  return TLS_FAILURE_COPY[code];
}

/** The message with the link it should carry, so a caller cannot render one without the other. */
export function tlsFailureGuidance(code: TlsFailureCode, detail?: string): TlsFailureGuidance {
  const { docAnchor } = TLS_FAILURE_COPY[code];
  const message = tlsFailureMessage(code, detail);
  return docAnchor ? { message, docAnchor } : { message };
}

/**
 * The sentence the operator reads for a failure. The retry hint is added only when retrying can
 * actually change the outcome, which is what keeps it from being advice that wastes a minute.
 */
export function tlsFailureMessage(code: TlsFailureCode, detail?: string): string {
  const copy = TLS_FAILURE_COPY[code];
  const parts = [copy.headline, copy.fix];
  if (copy.includeDetail && detail) parts.push(detail);
  const message = parts.join(' ');
  return copy.retryUseless ? message : `${message} Use Re-run provisioning below to try again.`;
}
