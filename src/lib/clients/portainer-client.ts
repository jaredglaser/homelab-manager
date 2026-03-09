import { Agent } from 'undici';
import type { PortainerEndpoint, PortainerStack } from '../../types/portainer';

// Covers both Bun's native fetch (`tls`) and Node.js-compat/undici fetch (`dispatcher`)
interface CrossRuntimeRequestInit extends RequestInit {
  tls?: { rejectUnauthorized?: boolean };
  dispatcher?: Agent;
}

export interface PortainerConfig {
  url: string;
  token: string;
  allowSelfSignedCerts?: boolean;
}

/**
 * Portainer API client using native fetch
 *
 * Handles API key authentication and self-signed certificates.
 * All methods return typed responses from the Portainer REST API.
 */
export class PortainerClient {
  private baseUrl: string;
  private apiKey: string;
  private fetchOptions: CrossRuntimeRequestInit;

  constructor(config: PortainerConfig) {
    this.baseUrl = config.url;
    this.apiKey = config.token;
    this.fetchOptions = {};

    if (config.allowSelfSignedCerts) {
      // `tls` is Bun's native fetch option (used in production)
      // `dispatcher` is the undici Agent option (used in Vite SSR dev mode via Node.js-compat fetch)
      // Both are set so the correct one is picked up by whichever fetch implementation is active
      this.fetchOptions.tls = { rejectUnauthorized: false };
      this.fetchOptions.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    }
  }

  /**
   * Make an authenticated GET request to the Portainer API
   */
  private async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      ...this.fetchOptions,
      headers: {
        'X-API-Key': this.apiKey,
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Portainer API error: ${response.status} ${response.statusText} - ${text}`
      );
    }

    return (await response.json()) as T;
  }

  /**
   * Make an authenticated PUT request to the Portainer API
   */
  private async put<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      ...this.fetchOptions,
      method: 'PUT',
      headers: {
        'X-API-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Portainer API error: ${response.status} ${response.statusText} - ${text}`
      );
    }

    return (await response.json()) as T;
  }

  /**
   * Test connectivity to the Portainer API
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.get<unknown>('/api/system/status');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get all endpoints (environments)
   */
  async getEndpoints(): Promise<PortainerEndpoint[]> {
    return this.get<PortainerEndpoint[]>('/api/endpoints');
  }

  /**
   * Get all stacks
   */
  async getStacks(): Promise<PortainerStack[]> {
    return this.get<PortainerStack[]>('/api/stacks');
  }

  /**
   * Get the compose file content for a stack
   */
  async getStackFile(stackId: number): Promise<{ StackFileContent: string }> {
    return this.get<{ StackFileContent: string }>(`/api/stacks/${stackId}/file`);
  }

  /**
   * Redeploy a git-based stack
   */
  async redeployStack(stackId: number, endpointId: number): Promise<unknown> {
    return this.put(
      `/api/stacks/${stackId}/git/redeploy?endpointId=${endpointId}`,
      {
        pullImage: true,
        prune: false,
        repositoryAuthentication: false,
      }
    );
  }
}

/**
 * Portainer connection manager singleton
 * Caches client instances by URL
 */
export class PortainerConnectionManager {
  private clients = new Map<string, PortainerClient>();

  getClient(config: PortainerConfig): PortainerClient {
    const key = config.url;

    let client = this.clients.get(key);
    if (!client) {
      client = new PortainerClient(config);
      this.clients.set(key, client);
    }

    return client;
  }

  clearAll(): void {
    this.clients.clear();
  }
}

export const portainerConnectionManager = new PortainerConnectionManager();
