import type { AgentStackResponse, AgentHealthCheckResponse } from '@homelab-manager/agent/types';
import type { AgentDeployPayload, AgentDeployResponse, AgentUpdatePayload } from '@/lib/deploy/types';
import { retry } from '@/lib/utils/backoff';

/** Agent's 15-min pull+up budget on /stacks/update, plus 1 min network slack. */
const UPDATE_TIMEOUT_MS = 960_000;

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
  /** Deploy/teardown timeout in milliseconds. Default: 300_000 (5 minutes). */
  timeoutMs?: number;
  /** Start/stop/restart timeout in milliseconds. Default: 60_000 (1 minute). */
  controlTimeoutMs?: number;
  /** Injectable fetch for testing. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

export interface AgentHealthResponse {
  status: 'healthy' | 'unhealthy';
  version: string;
}

/**
 * Request body for stack control operations (start, stop, restart).
 * `action` is absent because it maps to the HTTP endpoint path
 * (/stacks/start, /stacks/stop, /stacks/restart), not the request body.
 */
export type StackControlRequest =
  | { stack: string; scope: 'stack' }
  | { stack: string; scope: 'service'; service: string };

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
  private readonly controlTimeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(config: AgentClientConfig) {
    // Strip trailing slash
    this.agentUrl = config.agentUrl.replace(/\/$/, '');
    this.signer = config.signer;
    this.timeoutMs = config.timeoutMs ?? 300_000;
    this.controlTimeoutMs = config.controlTimeoutMs ?? 60_000;
    this.fetchFn = config.fetchFn ?? fetch;
  }

  async deploy(payload: AgentDeployPayload): Promise<AgentDeployResponse> {
    const raw = await this.postJson<AgentStackResponse>('/stacks/deploy', payload);
    return adaptDeployResponse(raw);
  }

  async update(payload: AgentUpdatePayload): Promise<AgentDeployResponse> {
    let raw: AgentStackResponse;
    try {
      raw = await this.postJson<AgentStackResponse>('/stacks/update', payload, UPDATE_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof AgentClientError && err.statusCode === 404) {
        const host = safeHost(this.agentUrl);
        throw new AgentClientError(
          `Agent on ${host} does not support image updates. Update the agent container and retry.`,
          err.statusCode,
          err.agentUrl,
          err.wasTimeout,
        );
      }
      throw err;
    }
    return adaptDeployResponse(raw);
  }

  async teardown(stack: string): Promise<AgentDeployResponse> {
    const raw = await this.postJson<AgentStackResponse>('/stacks/teardown', { stack });
    return adaptDeployResponse(raw);
  }

  async restart(req: StackControlRequest): Promise<AgentDeployResponse> {
    const raw = await this.postJson<AgentStackResponse>('/stacks/restart', req, this.controlTimeoutMs);
    return adaptDeployResponse(raw);
  }

  async start(req: StackControlRequest): Promise<AgentDeployResponse> {
    const raw = await this.postJson<AgentStackResponse>('/stacks/start', req, this.controlTimeoutMs);
    return adaptDeployResponse(raw);
  }

  async stop(req: StackControlRequest): Promise<AgentDeployResponse> {
    const raw = await this.postJson<AgentStackResponse>('/stacks/stop', req, this.controlTimeoutMs);
    return adaptDeployResponse(raw);
  }

  async startContainer(containerId: string): Promise<void> {
    await this.postJson<{ status: string }>(`/containers/${containerId}/start`, {}, this.controlTimeoutMs);
  }

  async stopContainer(containerId: string): Promise<void> {
    await this.postJson<{ status: string }>(`/containers/${containerId}/stop`, {}, this.controlTimeoutMs);
  }

  async restartContainer(containerId: string): Promise<void> {
    await this.postJson<{ status: string }>(`/containers/${containerId}/restart`, {}, this.controlTimeoutMs);
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

  private async postJson<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
    const jwt = await this.signer();
    return this.request<T>(path, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, timeoutMs);
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

  private async request<T>(path: string, init: RequestInit, timeoutMs?: number): Promise<T> {
    const MAX_RETRIES = 2; // maxAttempts - 1
    const url = `${this.agentUrl}${path}`;
    return retry(() => this.attempt<T>(url, init, timeoutMs), {
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

  private async attempt<T>(url: string, init: RequestInit, timeoutMs?: number): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
        redirect: 'manual',
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

    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new AgentClientError('Agent URL returned an unexpected redirect', response.status, url, false);
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

function safeHost(agentUrl: string): string {
  try {
    return new URL(agentUrl).host;
  } catch {
    return agentUrl;
  }
}

/** Map the agent's raw `{ status, stdout, stderr }` to internal `{ success, logs }`. */
function adaptDeployResponse(raw: AgentStackResponse): AgentDeployResponse {
  return {
    success: raw.status === 'success',
    logs: [raw.stdout, raw.stderr].filter(Boolean).join('\n'),
  };
}
