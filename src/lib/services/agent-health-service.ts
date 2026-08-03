import type { AgentHealthCheckResponse, AgentInfoResponse } from '@homelab-manager/agent/types';

export interface AgentInfoDetail {
  version?: string;
  dockerVersion?: string;
  agentImage?: string | null;
  agentImageTag?: string | null;
  infoSupported?: boolean;
}

export type AgentHealthResult =
  | ({ healthy: true } & AgentInfoDetail)
  | { healthy: false; error: string };

const HEALTH_CHECK_TIMEOUT_MS = 5000;

// The agent-side parsers are not a control here: a hostile agent puts what it likes in
// the JSON body, and these land in unbounded TEXT columns every user then loads.
const MAX_REPORTED_FIELD_LENGTH = 256;

function boundedAgentField(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_REPORTED_FIELD_LENGTH) return null;
  return trimmed;
}

/**
 * Fetch version and capability detail from the agent's authenticated /info
 * endpoint. Best-effort: returns an empty object on any failure so liveness
 * reporting is never blocked by missing detail.
 * getToken failures are silent (expected for pending/unenrolled hosts).
 * HTTP errors and network failures are logged so operators can diagnose why
 * version info is missing in Settings -> Managed Hosts.
 *
 * @returns `infoSupported: false` when the agent predates /info (404), which
 * callers use to tell "version unknown" apart from "version unchanged".
 * `agentImage`/`agentImageTag` are null when the agent predates image reporting or could not tell.
 */
async function fetchAgentInfo(
  agentUrl: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
  getToken: () => Promise<string>
): Promise<AgentInfoDetail> {
  let token: string;
  try {
    token = await getToken();
  } catch {
    return {};
  }

  try {
    const response = await fetchFn(`${agentUrl}/info`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    if (response.status === 404) {
      console.info(
        `[agent-health] ${agentUrl} has no /info endpoint; agent predates authenticated version reporting`
      );
      return { infoSupported: false };
    }
    if (!response.ok) {
      console.error(`[agent-health] /info returned ${response.status} for ${agentUrl}`);
      return {};
    }
    const data = (await response.json()) as AgentInfoResponse;
    return {
      version: boundedAgentField(data.agentVersion) ?? undefined,
      dockerVersion: boundedAgentField(data.capabilities?.docker?.version) ?? undefined,
      agentImage: boundedAgentField(data.agentImage),
      agentImageTag: boundedAgentField(data.agentImageTag),
      infoSupported: true,
    };
  } catch (err) {
    console.error(
      `[agent-health] /info request failed for ${agentUrl}:`,
      err instanceof Error ? err.message : err
    );
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

    // Validate the body shape to confirm this is an agent response, not an
    // unrelated HTTP server that happens to return 200.
    let body: AgentHealthCheckResponse;
    try {
      body = (await response.json()) as AgentHealthCheckResponse;
    } catch {
      return { healthy: false, error: `Agent returned non-JSON response (status ${response.status})` };
    }
    if (body?.status !== 'healthy') {
      return { healthy: false, error: 'Agent /health response missing expected status field' };
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
