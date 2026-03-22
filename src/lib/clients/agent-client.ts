import type { AgentStackResponse, AgentHealthCheckResponse } from '@homelab-manager/agent/types';
import type { AgentDeployPayload, AgentDeployResponse } from '@/lib/deploy/types';

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
  ) {
    super(message);
    this.name = 'AgentClientError';
  }
}

interface AgentClientConfig {
  agentUrl: string;
  agentToken: string;
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
 * HTTPS is supported natively — use https:// in the agent URL.
 * For self-signed certs (e.g., from OpenBao PKI), set NODE_EXTRA_CA_CERTS
 * env var to the CA certificate path.
 */
export class AgentClient {
  private readonly agentUrl: string;
  private readonly agentToken: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(config: AgentClientConfig) {
    // Strip trailing slash
    this.agentUrl = config.agentUrl.replace(/\/$/, '');
    this.agentToken = config.agentToken;
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
    const response = await this.fetchFn(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${this.agentToken}` },
      signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AgentClientError(`Agent returned ${response.status}: ${body}`, response.status, url);
    }

    if (!response.body) {
      throw new AgentClientError('No response body for SSE stream', undefined, url);
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
    return this.request<T>(path, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.agentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  private async getJson<T>(path: string): Promise<T> {
    return this.request<T>(path, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.agentToken}`,
      },
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const url = `${this.agentUrl}${path}`;

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new AgentClientError(
        `Agent request failed: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        url,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AgentClientError(
        `Agent returned ${response.status}: ${body}`,
        response.status,
        url,
      );
    }

    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AgentClientError(
        `Agent returned invalid JSON from ${path}: ${text.slice(0, 200)}`,
        response.status,
        url,
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
