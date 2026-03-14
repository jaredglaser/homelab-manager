// src/lib/clients/agent-client.ts

import type { AgentDeployPayload, AgentDeployResponse } from '@/lib/deploy/types';

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

interface AgentHealthResponse {
  status: string;
  version: string;
}

/**
 * Thin HTTP client for communicating with the homelab-manager agent.
 * All requests include the bearer token and a timeout via AbortSignal.
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
    return this.postJson<AgentDeployResponse>('/stacks/deploy', payload);
  }

  async teardown(stack: string): Promise<AgentDeployResponse> {
    return this.postJson<AgentDeployResponse>('/stacks/teardown', { stack });
  }

  async restart(stack: string): Promise<AgentDeployResponse> {
    return this.postJson<AgentDeployResponse>('/stacks/restart', { stack });
  }

  async health(): Promise<AgentHealthResponse> {
    return this.getJson<AgentHealthResponse>('/health');
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

    return response.json() as Promise<T>;
  }
}
