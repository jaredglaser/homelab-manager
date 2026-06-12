import type { AgentHealthCheckResponse, AgentInfoResponse } from '@homelab-manager/agent/types';

export type AgentHealthResult =
  | { healthy: true; version?: string; dockerVersion?: string }
  | { healthy: false; error: string };

const HEALTH_CHECK_TIMEOUT_MS = 5000;

/**
 * Fetch version and capability detail from the agent's authenticated /info
 * endpoint. Best-effort: returns an empty object on any failure (no keypair
 * yet, agent too old to serve /info, network error) so liveness reporting is
 * never blocked by missing detail.
 */
async function fetchAgentInfo(
  agentUrl: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
  getToken: () => Promise<string>
): Promise<{ version?: string; dockerVersion?: string }> {
  try {
    const token = await getToken();
    const response = await fetchFn(`${agentUrl}/info`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    if (!response.ok) return {};
    const data = (await response.json()) as AgentInfoResponse;
    return {
      version: data.agentVersion,
      dockerVersion: data.capabilities?.docker?.version,
    };
  } catch {
    return {};
  }
}

/**
 * Check the health of an agent by calling its unauthenticated /health endpoint
 * (liveness only, the agent strips version and capability detail from it).
 * When `getToken` is provided, version info is fetched from the authenticated
 * /info endpoint; failures there do not affect the healthy verdict.
 * Never throws: all errors are captured in the result.
 *
 * @param fetchFn - Injectable fetch function for testing (defaults to globalThis.fetch)
 * @param getToken - Optional JWT minter for the authenticated /info request
 */
export async function checkAgentHealth(
  agentUrl: string,
  timeoutMs: number = HEALTH_CHECK_TIMEOUT_MS,
  fetchFn: typeof fetch = globalThis.fetch,
  getToken?: () => Promise<string>
): Promise<AgentHealthResult> {
  try {
    const response = await fetchFn(`${agentUrl}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });

    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      return { healthy: false, error: 'Agent URL returned an unexpected redirect' };
    }

    if (!response.ok) {
      return {
        healthy: false,
        error: `Agent returned status ${response.status}`,
      };
    }

    // Parse the body to confirm the URL points at an agent and not some other
    // HTTP server that happens to return 200.
    try {
      (await response.json()) as AgentHealthCheckResponse;
    } catch {
      return { healthy: false, error: `Agent returned non-JSON response (status ${response.status})` };
    }

    const info = getToken
      ? await fetchAgentInfo(agentUrl, timeoutMs, fetchFn, getToken)
      : {};

    return { healthy: true, ...info };
  } catch (err: unknown) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return {
        healthy: false,
        error: `Health check timed out after ${timeoutMs}ms`,
      };
    }

    return {
      healthy: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
