import type { AgentStackResponse, AgentHealthCheckResponse } from '@homelab-manager/agent/types';
import type { AgentDeployPayload, AgentDeployResponse } from '@/lib/deploy/types';
import { retry } from '@/lib/utils/backoff';

export interface ZfsPool {
  name: string;
  size: number;
  allocated: number;
  free: number;
  fragmentation: number | null;
  capacity: number;
  dedup: number;
  health: string;
}

export interface ZfsStatsEvent {
  line: string;
  timestamp: number;
}

export class AgentClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly agentUrl?: string,
    /** True when the per-attempt timeout fired. Retry classifier uses this to avoid
     *  re-running a long-running operation (e.g. `docker compose up`) that may still
     *  be in flight on the agent. */
    public readonly wasTimeout: boolean = false,
  ) {
    super(message);
    this.name = 'AgentClientError';
  }
}

interface AgentClientConfig {
  agentUrl: string;
  signer: () => Promise<string>;
  /** Deploy timeout in milliseconds. Default: 300_000 (5 minutes). */
  timeoutMs?: number;
  /** Injectable fetch for testing. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

export interface AgentHealthResponse {
  status: 'healthy' | 'unhealthy';
  version: string;
}

/**
 * Thin HTTP client for communicating with the homelab-manager agent.
 * All requests include the bearer token and a timeout via AbortSignal.
 * Adapts the raw agent JSON into the internal AgentDeployResponse / AgentHealthResponse shapes.
 *
 * HTTPS is supported natively: use https:// in the agent URL.
 * For self-signed certs, set NODE_EXTRA_CA_CERTS env var to the CA certificate path.
 *
 * Transient failures (network errors, 502/503/504) are retried up to 3 total
 * attempts with exponential backoff (1s, 2s) via the shared `retry()` helper.
 * 4xx responses, non-retryable 5xx responses, per-attempt timeouts, and invalid
 * JSON bodies fail immediately.
 */
export class AgentClient {
  private readonly agentUrl: string;
  private readonly signer: () => Promise<string>;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(config: AgentClientConfig) {
    // Strip trailing slash
    this.agentUrl = config.agentUrl.replace(/\/$/, '');
    this.signer = config.signer;
    this.timeoutMs = config.timeoutMs ?? 300_000;
    this.fetchFn = config.fetchFn ?? fetch;
  }

  async deploy(payload: AgentDeployPayload): Promise<AgentDeployResponse> {
    const raw = await this.postJson<AgentStackResponse>('/stacks/deploy', payload);
    return adaptDeployResponse(raw);
  }

  async teardown(stack: string): Promise<AgentDeployResponse> {
    const raw = await this.postJson<AgentStackResponse>('/stacks/teardown', { stack });
    return adaptDeployResponse(raw);
  }

  async restart(stack: string): Promise<AgentDeployResponse> {
    const raw = await this.postJson<AgentStackResponse>('/stacks/restart', { stack });
    return adaptDeployResponse(raw);
  }

  async health(): Promise<AgentHealthResponse> {
    const raw = await this.getJson<AgentHealthCheckResponse>('/health');
    const version = raw.status === 'healthy'
      ? raw.agentVersion ?? raw.docker.version
      : raw.agentVersion;
    return { status: raw.status, version };
  }

  async getZfsPools(): Promise<ZfsPool[]> {
    const result = await this.getJson<{ pools: ZfsPool[] }>('/zfs/pools');
    return result.pools;
  }

  async *streamZfsStats(signal: AbortSignal): AsyncGenerator<ZfsStatsEvent> {
    const url = `${this.agentUrl}/zfs/stats/stream`;
    const jwt = await this.signer();
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${jwt}` },
        signal,
      });
    } catch (err) {
      throw new AgentClientError(
        `Agent request failed: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        url,
        false,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AgentClientError(`Agent returned ${response.status}: ${body}`, response.status, url, false);
    }

    if (!response.body) {
      throw new AgentClientError('No response body for SSE stream', undefined, url, false);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            try {
              yield JSON.parse(data) as ZfsStatsEvent;
            } catch {
              // Skip malformed events
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const jwt = await this.signer();
    return this.request<T>(path, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  private async getJson<T>(path: string): Promise<T> {
    const jwt = await this.signer();
    return this.request<T>(path, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${jwt}` },
    });
  }

  /** Classifier used by the retry wrapper. Exposed as a static so the retry
   *  helper can call it without binding `this`. */
  private static isRetryable(err: unknown): boolean {
    if (!(err instanceof AgentClientError)) return false;
    // Never retry our own per-attempt timeout: the in-flight operation (e.g.
    // `docker compose up`) may still be running on the agent.
    if (err.wasTimeout) return false;
    // Network-layer failures (fetch threw) have no statusCode, retry.
    if (err.statusCode === undefined) return true;
    // Transient gateway errors are retryable; everything else is not.
    return err.statusCode === 502 || err.statusCode === 503 || err.statusCode === 504;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const MAX_RETRIES = 2; // maxAttempts - 1
    const url = `${this.agentUrl}${path}`;
    return retry(() => this.attempt<T>(url, init), {
      maxAttempts: MAX_RETRIES + 1,
      baseMs: 1000,
      maxExponent: 2,
      isRetryable: AgentClient.isRetryable,
      onRetry: (err, attempt, delayMs) => {
        const code = err instanceof AgentClientError
          ? (err.statusCode ?? 'network error')
          : 'unknown';
        console.info(
          `[AgentClient] Retry ${attempt}/${MAX_RETRIES} for ${path} after ${code}, waiting ${delayMs}ms`,
        );
      },
    });
  }

  private async attempt<T>(url: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Distinguish our own per-attempt timeout from a genuine network failure.
      // DOMException('...', 'TimeoutError') is the canonical AbortSignal.timeout()
      // rejection, but some runtimes surface a plain AbortError, treat both as
      // "our timeout" to be safe.
      const wasTimeout =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new AgentClientError(
        `Agent request failed: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        url,
        wasTimeout,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AgentClientError(
        `Agent returned ${response.status}: ${body}`,
        response.status,
        url,
        false,
      );
    }

    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AgentClientError(
        `Agent returned invalid JSON from ${url}: ${text.slice(0, 200)}`,
        response.status,
        url,
        false,
      );
    }
  }
}

/** Map the agent's raw `{ status, stdout, stderr }` to internal `{ success, logs }`. */
function adaptDeployResponse(raw: AgentStackResponse): AgentDeployResponse {
  return {
    success: raw.status === 'success',
    logs: [raw.stdout, raw.stderr].filter(Boolean).join('\n'),
  };
}
