export interface AgentHealthResponse {
  status: string;
  version: string;
  dockerVersion?: string;
  uptime?: number;
}

export interface AgentHealthResult {
  healthy: boolean;
  version?: string;
  dockerVersion?: string;
  error?: string;
}

const HEALTH_CHECK_TIMEOUT_MS = 5000;

/**
 * Check the health of an agent by calling its /health endpoint.
 * Returns a result object indicating health status and version info.
 * Never throws — all errors are captured in the result.
 *
 * @param fetchFn - Injectable fetch function for testing (defaults to globalThis.fetch)
 */
export async function checkAgentHealth(
  agentUrl: string,
  timeoutMs: number = HEALTH_CHECK_TIMEOUT_MS,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<AgentHealthResult> {
  try {
    const response = await fetchFn(`${agentUrl}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return {
        healthy: false,
        error: `Agent returned status ${response.status}`,
      };
    }

    const data = (await response.json()) as AgentHealthResponse;

    return {
      healthy: true,
      version: data.version,
      dockerVersion: data.dockerVersion,
    };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
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
