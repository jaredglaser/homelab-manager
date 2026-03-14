# OpenBao Integration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate OpenBao as an optional secrets manager for Docker stack deployments. Provides a thin HTTP client for OpenBao's KV v2 secrets engine, a config loader, server functions for CRUD operations on secrets, and an implementation of the SecretResolver interface used by the deploy pipeline.

**Architecture:** The OpenBao client lives in `src/lib/clients/openbao-client.ts` and uses native `fetch()` to call the OpenBao HTTP API (no SDK). Config is loaded from `OPENBAO_URL` and `OPENBAO_TOKEN` env vars via Zod validation in `src/lib/config/openbao-config.ts`. Server functions in `src/lib/server-functions/openbao-server-functions.ts` expose secret CRUD to the frontend via `createServerFn()` + middleware. The SecretResolver implementation in `src/lib/services/openbao-secret-resolver.ts` bridges OpenBao into the deploy pipeline. Activation is gated on `OPENBAO_URL` being set (not the main `DOCKER_MANAGEMENT_FEATURE_FLAG`).

**Tech Stack:** Native `fetch()`, Zod, `createServerFn()` + `createMiddleware()` from TanStack Start, `bun:test`

**Spec:** `docs/superpowers/specs/2026-03-13-docker-stack-management-design.md` (Section 6: OpenBao Integration)

---

## Chunk 1: Config & Client

### Task 1: OpenBao config loader

**Files:**
- Create: `src/lib/config/openbao-config.ts`
- Create: `src/lib/config/__tests__/openbao-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/config/__tests__/openbao-config.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { loadOpenBaoConfig, isOpenBaoConfigured } from '@/lib/config/openbao-config';

describe('loadOpenBaoConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('loads config from environment variables', () => {
    process.env.OPENBAO_URL = 'http://openbao:8200';
    process.env.OPENBAO_TOKEN = 'dev-root-token';

    const config = loadOpenBaoConfig();
    expect(config.url).toBe('http://openbao:8200');
    expect(config.token).toBe('dev-root-token');
  });

  test('strips trailing slash from URL', () => {
    process.env.OPENBAO_URL = 'http://openbao:8200/';
    process.env.OPENBAO_TOKEN = 'dev-root-token';

    const config = loadOpenBaoConfig();
    expect(config.url).toBe('http://openbao:8200');
  });

  test('throws when OPENBAO_URL is missing', () => {
    delete process.env.OPENBAO_URL;
    process.env.OPENBAO_TOKEN = 'dev-root-token';

    expect(() => loadOpenBaoConfig()).toThrow();
  });

  test('throws when OPENBAO_TOKEN is missing', () => {
    process.env.OPENBAO_URL = 'http://openbao:8200';
    delete process.env.OPENBAO_TOKEN;

    expect(() => loadOpenBaoConfig()).toThrow();
  });

  test('throws for invalid URL format', () => {
    process.env.OPENBAO_URL = 'not-a-url';
    process.env.OPENBAO_TOKEN = 'dev-root-token';

    expect(() => loadOpenBaoConfig()).toThrow();
  });
});

describe('isOpenBaoConfigured', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('returns true when OPENBAO_URL is set', () => {
    process.env.OPENBAO_URL = 'http://openbao:8200';
    expect(isOpenBaoConfigured()).toBe(true);
  });

  test('returns false when OPENBAO_URL is not set', () => {
    delete process.env.OPENBAO_URL;
    expect(isOpenBaoConfigured()).toBe(false);
  });

  test('returns false when OPENBAO_URL is empty string', () => {
    process.env.OPENBAO_URL = '';
    expect(isOpenBaoConfigured()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/config/__tests__/openbao-config.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the config loader**

Create `src/lib/config/openbao-config.ts`:

```typescript
import { z } from 'zod';

const OpenBaoConfigSchema = z.object({
  url: z
    .string()
    .min(1)
    .url()
    .transform((val) => val.replace(/\/+$/, '')),
  token: z.string().min(1),
});

export type OpenBaoConfig = z.infer<typeof OpenBaoConfigSchema>;

/**
 * Load OpenBao configuration from environment variables
 *
 * Required env vars:
 *   OPENBAO_URL - OpenBao server URL (e.g., http://openbao:8200)
 *   OPENBAO_TOKEN - Authentication token
 *
 * @returns Validated OpenBao configuration
 * @throws {z.ZodError} If configuration is invalid
 */
export function loadOpenBaoConfig(): OpenBaoConfig {
  return OpenBaoConfigSchema.parse({
    url: process.env.OPENBAO_URL || '',
    token: process.env.OPENBAO_TOKEN || '',
  });
}

/**
 * Check if OpenBao configuration is available (OPENBAO_URL env var set)
 */
export function isOpenBaoConfigured(): boolean {
  return !!process.env.OPENBAO_URL;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/config/__tests__/openbao-config.test.ts`
Expected: All tests pass

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/lib/config/openbao-config.ts src/lib/config/__tests__/openbao-config.test.ts
git commit -m "feat(openbao): add config loader with Zod validation"
```

---

### Task 2: OpenBao KV v2 client

**Files:**
- Create: `src/lib/clients/openbao-client.ts`
- Create: `src/lib/clients/__tests__/openbao-client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/clients/__tests__/openbao-client.test.ts`:

```typescript
import { describe, expect, test, beforeEach, mock } from 'bun:test';
import { OpenBaoClient } from '@/lib/clients/openbao-client';

describe('OpenBaoClient', () => {
  let client: OpenBaoClient;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    mockFetch = mock();
    client = new OpenBaoClient(
      { url: 'http://openbao:8200', token: 'dev-root-token' },
      mockFetch as typeof fetch,
    );
  });

  describe('listSecrets', () => {
    test('calls LIST on metadata path and returns keys', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { keys: ['DB_PASSWORD', 'API_KEY'] },
          }),
          { status: 200 },
        ),
      );

      const keys = await client.listSecrets('plex');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'http://openbao:8200/v1/secret/metadata/stacks/plex',
      );
      expect(opts.method).toBe('LIST');
      expect(opts.headers).toEqual({
        'X-Vault-Token': 'dev-root-token',
      });
      expect(keys).toEqual(['DB_PASSWORD', 'API_KEY']);
    });

    test('returns empty array when no secrets exist (404)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 404 }),
      );

      const keys = await client.listSecrets('empty-stack');
      expect(keys).toEqual([]);
    });

    test('throws on non-404 error responses', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Internal Server Error', { status: 500 }),
      );

      await expect(client.listSecrets('plex')).rejects.toThrow(
        'OpenBao API error: 500',
      );
    });
  });

  describe('getSecret', () => {
    test('reads secret value from data path', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              data: { value: 'super-secret-password' },
              metadata: { version: 1 },
            },
          }),
          { status: 200 },
        ),
      );

      const value = await client.getSecret('plex', 'DB_PASSWORD');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'http://openbao:8200/v1/secret/data/stacks/plex/DB_PASSWORD',
      );
      expect(opts.method).toBe('GET');
      expect(value).toBe('super-secret-password');
    });

    test('returns null when secret does not exist (404)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 404 }),
      );

      const value = await client.getSecret('plex', 'MISSING');
      expect(value).toBeNull();
    });

    test('throws on non-404 error responses', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Forbidden', { status: 403 }),
      );

      await expect(
        client.getSecret('plex', 'DB_PASSWORD'),
      ).rejects.toThrow('OpenBao API error: 403');
    });
  });

  describe('setSecret', () => {
    test('writes secret value to data path', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { version: 1 },
          }),
          { status: 200 },
        ),
      );

      await client.setSecret('plex', 'DB_PASSWORD', 'new-password');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'http://openbao:8200/v1/secret/data/stacks/plex/DB_PASSWORD',
      );
      expect(opts.method).toBe('POST');
      expect(opts.headers).toEqual({
        'X-Vault-Token': 'dev-root-token',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(opts.body as string)).toEqual({
        data: { value: 'new-password' },
      });
    });

    test('throws on error response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Bad Request', { status: 400 }),
      );

      await expect(
        client.setSecret('plex', 'DB_PASSWORD', 'val'),
      ).rejects.toThrow('OpenBao API error: 400');
    });
  });

  describe('deleteSecret', () => {
    test('deletes secret metadata and all versions', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 204 }),
      );

      await client.deleteSecret('plex', 'DB_PASSWORD');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'http://openbao:8200/v1/secret/metadata/stacks/plex/DB_PASSWORD',
      );
      expect(opts.method).toBe('DELETE');
    });

    test('does not throw on 404 (already deleted)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 404 }),
      );

      await expect(
        client.deleteSecret('plex', 'DB_PASSWORD'),
      ).resolves.toBeUndefined();
    });

    test('throws on non-404 error response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Forbidden', { status: 403 }),
      );

      await expect(
        client.deleteSecret('plex', 'DB_PASSWORD'),
      ).rejects.toThrow('OpenBao API error: 403');
    });
  });

  describe('getAllSecrets', () => {
    test('lists and fetches all secrets for a stack', async () => {
      // First call: list secrets
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { keys: ['DB_PASSWORD', 'API_KEY'] },
          }),
          { status: 200 },
        ),
      );
      // Second call: get DB_PASSWORD
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { data: { value: 'pass123' }, metadata: { version: 1 } },
          }),
          { status: 200 },
        ),
      );
      // Third call: get API_KEY
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { data: { value: 'key456' }, metadata: { version: 1 } },
          }),
          { status: 200 },
        ),
      );

      const secrets = await client.getAllSecrets('plex');
      expect(secrets).toEqual({
        DB_PASSWORD: 'pass123',
        API_KEY: 'key456',
      });
    });

    test('returns empty record when no secrets exist', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 404 }),
      );

      const secrets = await client.getAllSecrets('empty-stack');
      expect(secrets).toEqual({});
    });

    test('skips secrets that return null on read', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { keys: ['DELETED_KEY'] } }),
          { status: 200 },
        ),
      );
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 404 }),
      );

      const secrets = await client.getAllSecrets('plex');
      expect(secrets).toEqual({});
    });
  });

  describe('ensureSecretsEngine', () => {
    test('does not re-enable if already mounted', async () => {
      // GET /v1/sys/mounts returns existing mounts including secret/
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            'secret/': { type: 'kv', options: { version: '2' } },
          }),
          { status: 200 },
        ),
      );

      await client.ensureSecretsEngine();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test('enables KV v2 engine when not mounted', async () => {
      // GET /v1/sys/mounts — no secret/ mount
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      );
      // POST /v1/sys/mounts/secret — enable engine
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 204 }),
      );

      await client.ensureSecretsEngine();
      expect(mockFetch).toHaveBeenCalledTimes(2);

      const [url, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
      expect(url).toBe('http://openbao:8200/v1/sys/mounts/secret');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body as string)).toEqual({
        type: 'kv',
        options: { version: '2' },
      });
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/clients/__tests__/openbao-client.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the OpenBao client**

Create `src/lib/clients/openbao-client.ts`:

```typescript
import type { OpenBaoConfig } from '@/lib/config/openbao-config';

/**
 * Thin wrapper around OpenBao HTTP API (KV v2 secrets engine).
 * Uses native fetch() — no SDK dependency.
 *
 * Secret path convention: secret/stacks/<stack-name>/<key>
 */
export class OpenBaoClient {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: OpenBaoConfig, fetchFn: typeof fetch = globalThis.fetch) {
    this.url = config.url;
    this.token = config.token;
    this.fetchFn = fetchFn;
  }

  /**
   * List secret key names for a stack. Returns names only, never values.
   */
  async listSecrets(stack: string): Promise<string[]> {
    const response = await this.fetchFn(
      `${this.url}/v1/secret/metadata/stacks/${stack}`,
      {
        method: 'LIST',
        headers: { 'X-Vault-Token': this.token },
      },
    );

    if (response.status === 404) {
      return [];
    }

    if (!response.ok) {
      throw new Error(`OpenBao API error: ${response.status}`);
    }

    const body = await response.json();
    return body.data.keys as string[];
  }

  /**
   * Get a single secret value. Returns null if not found.
   */
  async getSecret(stack: string, key: string): Promise<string | null> {
    const response = await this.fetchFn(
      `${this.url}/v1/secret/data/stacks/${stack}/${key}`,
      {
        method: 'GET',
        headers: { 'X-Vault-Token': this.token },
      },
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`OpenBao API error: ${response.status}`);
    }

    const body = await response.json();
    return body.data.data.value as string;
  }

  /**
   * Set or update a secret value.
   */
  async setSecret(stack: string, key: string, value: string): Promise<void> {
    const response = await this.fetchFn(
      `${this.url}/v1/secret/data/stacks/${stack}/${key}`,
      {
        method: 'POST',
        headers: {
          'X-Vault-Token': this.token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ data: { value } }),
      },
    );

    if (!response.ok) {
      throw new Error(`OpenBao API error: ${response.status}`);
    }
  }

  /**
   * Delete a secret (metadata and all versions).
   * Does not throw if the secret does not exist.
   */
  async deleteSecret(stack: string, key: string): Promise<void> {
    const response = await this.fetchFn(
      `${this.url}/v1/secret/metadata/stacks/${stack}/${key}`,
      {
        method: 'DELETE',
        headers: { 'X-Vault-Token': this.token },
      },
    );

    if (response.status === 404) {
      return;
    }

    if (!response.ok) {
      throw new Error(`OpenBao API error: ${response.status}`);
    }
  }

  /**
   * Get all secret key-value pairs for a stack.
   * Used by the deploy pipeline to build .env files.
   */
  async getAllSecrets(stack: string): Promise<Record<string, string>> {
    const keys = await this.listSecrets(stack);
    if (keys.length === 0) {
      return {};
    }

    const entries = await Promise.all(
      keys.map(async (key) => {
        const value = await this.getSecret(stack, key);
        return value !== null ? ([key, value] as const) : null;
      }),
    );

    return Object.fromEntries(
      entries.filter((entry): entry is [string, string] => entry !== null),
    );
  }

  /**
   * Ensure the KV v2 secrets engine is enabled at the `secret/` path.
   * Safe to call multiple times — checks existing mounts first.
   */
  async ensureSecretsEngine(): Promise<void> {
    const mountsResponse = await this.fetchFn(
      `${this.url}/v1/sys/mounts`,
      {
        method: 'GET',
        headers: { 'X-Vault-Token': this.token },
      },
    );

    if (!mountsResponse.ok) {
      throw new Error(`OpenBao API error: ${mountsResponse.status}`);
    }

    const mounts = await mountsResponse.json();
    if (mounts['secret/']) {
      return;
    }

    const enableResponse = await this.fetchFn(
      `${this.url}/v1/sys/mounts/secret`,
      {
        method: 'POST',
        headers: {
          'X-Vault-Token': this.token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'kv',
          options: { version: '2' },
        }),
      },
    );

    if (!enableResponse.ok) {
      throw new Error(`OpenBao API error: ${enableResponse.status}`);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/clients/__tests__/openbao-client.test.ts`
Expected: All tests pass

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/lib/clients/openbao-client.ts src/lib/clients/__tests__/openbao-client.test.ts
git commit -m "feat(openbao): add KV v2 HTTP client with native fetch"
```

---

## Chunk 2: SecretResolver Interface & OpenBao Implementation

### Task 3: Define SecretResolver interface

**Files:**
- Create: `src/lib/services/secret-resolver.ts`

- [ ] **Step 1: Create the SecretResolver interface**

Create `src/lib/services/secret-resolver.ts`:

```typescript
/**
 * Interface for resolving secrets during stack deployment.
 * The deploy pipeline calls resolveSecrets() to build the .env file.
 *
 * Implementations:
 * - OpenBaoSecretResolver: fetches from OpenBao KV v2
 * - NoOpSecretResolver: returns empty record when OpenBao is not configured
 */
export interface SecretResolver {
  /**
   * Resolve all secrets for a given stack.
   * Returns a Record of key-value pairs to be written as .env content.
   */
  resolveSecrets(stack: string): Promise<Record<string, string>>;
}

/**
 * No-op implementation used when OpenBao is not configured.
 * Returns empty secrets — stacks use whatever .env files already exist on the host.
 */
export class NoOpSecretResolver implements SecretResolver {
  async resolveSecrets(_stack: string): Promise<Record<string, string>> {
    return {};
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/services/secret-resolver.ts
git commit -m "feat(openbao): define SecretResolver interface with no-op default"
```

---

### Task 4: OpenBao SecretResolver implementation

**Files:**
- Create: `src/lib/services/openbao-secret-resolver.ts`
- Create: `src/lib/services/__tests__/openbao-secret-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/services/__tests__/openbao-secret-resolver.test.ts`:

```typescript
import { describe, expect, test, mock } from 'bun:test';
import { OpenBaoSecretResolver } from '@/lib/services/openbao-secret-resolver';
import { OpenBaoClient } from '@/lib/clients/openbao-client';

describe('OpenBaoSecretResolver', () => {
  function createMockClient(
    secrets: Record<string, string>,
  ): OpenBaoClient {
    const mockFetch = mock();

    // list call
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: { keys: Object.keys(secrets) },
        }),
        { status: 200 },
      ),
    );

    // get calls for each key
    for (const value of Object.values(secrets)) {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { data: { value }, metadata: { version: 1 } },
          }),
          { status: 200 },
        ),
      );
    }

    return new OpenBaoClient(
      { url: 'http://openbao:8200', token: 'test' },
      mockFetch as typeof fetch,
    );
  }

  test('resolves all secrets for a stack', async () => {
    const client = createMockClient({
      DB_PASSWORD: 'pass123',
      API_KEY: 'key456',
    });
    const resolver = new OpenBaoSecretResolver(client);

    const result = await resolver.resolveSecrets('plex');
    expect(result).toEqual({
      DB_PASSWORD: 'pass123',
      API_KEY: 'key456',
    });
  });

  test('returns empty record when stack has no secrets', async () => {
    const mockFetch = mock();
    mockFetch.mockResolvedValueOnce(
      new Response(null, { status: 404 }),
    );

    const client = new OpenBaoClient(
      { url: 'http://openbao:8200', token: 'test' },
      mockFetch as typeof fetch,
    );
    const resolver = new OpenBaoSecretResolver(client);

    const result = await resolver.resolveSecrets('empty-stack');
    expect(result).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/services/__tests__/openbao-secret-resolver.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the OpenBao SecretResolver**

Create `src/lib/services/openbao-secret-resolver.ts`:

```typescript
import type { SecretResolver } from '@/lib/services/secret-resolver';
import type { OpenBaoClient } from '@/lib/clients/openbao-client';

/**
 * SecretResolver implementation backed by OpenBao KV v2.
 * Fetches all secrets for a stack and returns them as key-value pairs.
 */
export class OpenBaoSecretResolver implements SecretResolver {
  private readonly client: OpenBaoClient;

  constructor(client: OpenBaoClient) {
    this.client = client;
  }

  async resolveSecrets(stack: string): Promise<Record<string, string>> {
    return this.client.getAllSecrets(stack);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/services/__tests__/openbao-secret-resolver.test.ts`
Expected: All tests pass

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/lib/services/openbao-secret-resolver.ts src/lib/services/__tests__/openbao-secret-resolver.test.ts
git commit -m "feat(openbao): implement OpenBaoSecretResolver for deploy pipeline"
```

---

## Chunk 3: SecretResolver Factory

### Task 5: Factory function for SecretResolver

**Files:**
- Create: `src/lib/services/secret-resolver-factory.ts`
- Create: `src/lib/services/__tests__/secret-resolver-factory.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/services/__tests__/secret-resolver-factory.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { createSecretResolver } from '@/lib/services/secret-resolver-factory';
import { NoOpSecretResolver } from '@/lib/services/secret-resolver';
import { OpenBaoSecretResolver } from '@/lib/services/openbao-secret-resolver';

describe('createSecretResolver', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('returns NoOpSecretResolver when OpenBao is not configured', () => {
    delete process.env.OPENBAO_URL;
    delete process.env.OPENBAO_TOKEN;

    const resolver = createSecretResolver();
    expect(resolver).toBeInstanceOf(NoOpSecretResolver);
  });

  test('returns OpenBaoSecretResolver when OpenBao is configured', () => {
    process.env.OPENBAO_URL = 'http://openbao:8200';
    process.env.OPENBAO_TOKEN = 'dev-root-token';

    const resolver = createSecretResolver();
    expect(resolver).toBeInstanceOf(OpenBaoSecretResolver);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/services/__tests__/secret-resolver-factory.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the factory**

Create `src/lib/services/secret-resolver-factory.ts`:

```typescript
import { isOpenBaoConfigured, loadOpenBaoConfig } from '@/lib/config/openbao-config';
import { OpenBaoClient } from '@/lib/clients/openbao-client';
import { OpenBaoSecretResolver } from '@/lib/services/openbao-secret-resolver';
import { NoOpSecretResolver, type SecretResolver } from '@/lib/services/secret-resolver';

/**
 * Create the appropriate SecretResolver based on configuration.
 * Returns OpenBaoSecretResolver when OPENBAO_URL is set, NoOpSecretResolver otherwise.
 */
export function createSecretResolver(): SecretResolver {
  if (!isOpenBaoConfigured()) {
    return new NoOpSecretResolver();
  }

  const config = loadOpenBaoConfig();
  const client = new OpenBaoClient(config);
  return new OpenBaoSecretResolver(client);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/services/__tests__/secret-resolver-factory.test.ts`
Expected: All tests pass

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/lib/services/secret-resolver-factory.ts src/lib/services/__tests__/secret-resolver-factory.test.ts
git commit -m "feat(openbao): add SecretResolver factory with auto-detection"
```

---

## Chunk 4: OpenBao Middleware & Server Functions

### Task 6: OpenBao middleware

**Files:**
- Create: `src/middleware/openbao-middleware.ts`
- Create: `src/middleware/__tests__/openbao-middleware.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/middleware/__tests__/openbao-middleware.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { isOpenBaoConfigured } from '@/lib/config/openbao-config';

describe('openbao middleware config check', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('isOpenBaoConfigured returns true when env vars set', () => {
    process.env.OPENBAO_URL = 'http://openbao:8200';
    expect(isOpenBaoConfigured()).toBe(true);
  });

  test('isOpenBaoConfigured returns false when env vars not set', () => {
    delete process.env.OPENBAO_URL;
    expect(isOpenBaoConfigured()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test src/middleware/__tests__/openbao-middleware.test.ts`
Expected: All tests pass

- [ ] **Step 3: Implement OpenBao middleware**

Create `src/middleware/openbao-middleware.ts`:

```typescript
import { createMiddleware } from '@tanstack/react-start';
import type { OpenBaoClient } from '@/lib/clients/openbao-client';

/**
 * OpenBao middleware — injects an OpenBaoClient into the server function context.
 * Dynamically imports server-only modules to avoid leaking into the client bundle.
 */
export const openBaoMiddleware = createMiddleware().server(
  async ({ next }) => {
    const { isOpenBaoConfigured, loadOpenBaoConfig } = await import(
      '@/lib/config/openbao-config'
    );

    if (!isOpenBaoConfigured()) {
      throw new Error('OpenBao is not configured (OPENBAO_URL not set)');
    }

    const config = loadOpenBaoConfig();
    const { OpenBaoClient: Client } = await import(
      '@/lib/clients/openbao-client'
    );
    const client = new Client(config);

    return next({ context: { openBaoClient: client } });
  },
);
```

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/middleware/openbao-middleware.ts src/middleware/__tests__/openbao-middleware.test.ts
git commit -m "feat(openbao): add TanStack middleware for OpenBao client injection"
```

---

### Task 7: Server functions for secret CRUD

**Files:**
- Create: `src/lib/server-functions/openbao-server-functions.ts`
- Create: `src/lib/server-functions/__tests__/openbao-server-functions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/server-functions/__tests__/openbao-server-functions.test.ts`:

```typescript
import { describe, expect, test, mock } from 'bun:test';
import { OpenBaoClient } from '@/lib/clients/openbao-client';

/**
 * Unit tests for OpenBao server function logic.
 * Tests the underlying client calls that the server functions delegate to.
 * Server functions themselves are thin wrappers (createServerFn + middleware),
 * so we test the client integration layer here.
 */
describe('OpenBao server function logic', () => {
  function createClient(mockFetch: ReturnType<typeof mock>): OpenBaoClient {
    return new OpenBaoClient(
      { url: 'http://openbao:8200', token: 'dev-root-token' },
      mockFetch as typeof fetch,
    );
  }

  describe('listSecretNames', () => {
    test('returns sorted key names', async () => {
      const mockFetch = mock();
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { keys: ['ZEBRA', 'ALPHA', 'MIDDLE'] },
          }),
          { status: 200 },
        ),
      );

      const client = createClient(mockFetch);
      const keys = await client.listSecrets('mystack');
      const sorted = [...keys].sort();

      expect(sorted).toEqual(['ALPHA', 'MIDDLE', 'ZEBRA']);
    });
  });

  describe('revealSecret', () => {
    test('returns single secret value', async () => {
      const mockFetch = mock();
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { data: { value: 'revealed!' }, metadata: { version: 1 } },
          }),
          { status: 200 },
        ),
      );

      const client = createClient(mockFetch);
      const value = await client.getSecret('mystack', 'API_KEY');

      expect(value).toBe('revealed!');
    });

    test('returns null for missing secret', async () => {
      const mockFetch = mock();
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 404 }),
      );

      const client = createClient(mockFetch);
      const value = await client.getSecret('mystack', 'MISSING');

      expect(value).toBeNull();
    });
  });

  describe('setSecret', () => {
    test('writes secret and does not throw on success', async () => {
      const mockFetch = mock();
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { version: 1 } }),
          { status: 200 },
        ),
      );

      const client = createClient(mockFetch);
      await expect(
        client.setSecret('mystack', 'NEW_KEY', 'new-value'),
      ).resolves.toBeUndefined();
    });
  });

  describe('deleteSecret', () => {
    test('deletes secret and does not throw on success', async () => {
      const mockFetch = mock();
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 204 }),
      );

      const client = createClient(mockFetch);
      await expect(
        client.deleteSecret('mystack', 'OLD_KEY'),
      ).resolves.toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/server-functions/__tests__/openbao-server-functions.test.ts`
Expected: FAIL (or passes since it tests the client — verify module resolution works)

- [ ] **Step 3: Implement server functions**

Create `src/lib/server-functions/openbao-server-functions.ts`:

```typescript
import { createServerFn } from '@tanstack/react-start';
import { openBaoMiddleware } from '@/middleware/openbao-middleware';

/**
 * List secret names for a stack. Returns names only, never values.
 */
export const listStackSecrets = createServerFn({ method: 'GET' })
  .middleware([openBaoMiddleware])
  .validator((data: { stack: string }) => data)
  .handler(async ({ context, data }) => {
    const keys = await context.openBaoClient.listSecrets(data.stack);
    return keys.sort();
  });

/**
 * Get a single secret value (for reveal in UI).
 * Returns the value directly — the frontend should display it briefly and discard.
 */
export const getStackSecret = createServerFn({ method: 'GET' })
  .middleware([openBaoMiddleware])
  .validator((data: { stack: string; key: string }) => data)
  .handler(async ({ context, data }) => {
    const value = await context.openBaoClient.getSecret(data.stack, data.key);
    if (value === null) {
      throw new Error(`Secret not found: ${data.key}`);
    }
    return { value };
  });

/**
 * Set or update a secret value.
 */
export const setStackSecret = createServerFn({ method: 'POST' })
  .middleware([openBaoMiddleware])
  .validator((data: { stack: string; key: string; value: string }) => data)
  .handler(async ({ context, data }) => {
    await context.openBaoClient.setSecret(data.stack, data.key, data.value);
    return { success: true };
  });

/**
 * Delete a secret.
 */
export const deleteStackSecret = createServerFn({ method: 'POST' })
  .middleware([openBaoMiddleware])
  .validator((data: { stack: string; key: string }) => data)
  .handler(async ({ context, data }) => {
    await context.openBaoClient.deleteSecret(data.stack, data.key);
    return { success: true };
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/server-functions/__tests__/openbao-server-functions.test.ts`
Expected: All tests pass

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/lib/server-functions/openbao-server-functions.ts src/lib/server-functions/__tests__/openbao-server-functions.test.ts
git commit -m "feat(openbao): add server functions for secret CRUD operations"
```

---

## Chunk 5: Dev Setup & Initialization

### Task 8: Add OpenBao to docker-compose.dev.yml

**Files:**
- Modify: `docker-compose.dev.yml`

- [ ] **Step 1: Add OpenBao service to docker-compose.dev.yml**

Add the following service block to the `services:` section of `docker-compose.dev.yml`:

```yaml
  # OpenBao dev server (secrets management, optional)
  openbao:
    image: openbao/openbao
    container_name: homelab-openbao
    command: server -dev
    environment:
      BAO_DEV_ROOT_TOKEN_ID: "dev-root-token"
    ports:
      - "8200:8200"
    networks:
      - homelab-network
    profiles:
      - management
```

Add to the `x-shared-dev` environment or to the `web` service environment section:

```yaml
    environment:
      <<: *postgres-env
      OPENBAO_URL: ${OPENBAO_URL:-}
      OPENBAO_TOKEN: ${OPENBAO_TOKEN:-}
```

- [ ] **Step 2: Add env var examples to `.env.example`**

Add the following lines to `.env.example`:

```bash
# OpenBao (optional, enables secrets management for Docker stacks)
# OPENBAO_URL=http://localhost:8200
# OPENBAO_TOKEN=dev-root-token
```

- [ ] **Step 3: Verify docker-compose is valid**

Run: `docker compose -f docker-compose.dev.yml config --quiet`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add docker-compose.dev.yml .env.example
git commit -m "feat(openbao): add OpenBao dev server to docker-compose with management profile"
```

---

### Task 9: OpenBao initialization on first use

**Files:**
- Create: `src/lib/services/openbao-init.ts`
- Create: `src/lib/services/__tests__/openbao-init.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/services/__tests__/openbao-init.test.ts`:

```typescript
import { describe, expect, test, mock } from 'bun:test';
import { OpenBaoClient } from '@/lib/clients/openbao-client';

describe('OpenBao initialization', () => {
  test('ensureSecretsEngine is idempotent', async () => {
    const mockFetch = mock();

    // First call: check mounts — engine already exists
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          'secret/': { type: 'kv', options: { version: '2' } },
        }),
        { status: 200 },
      ),
    );

    const client = new OpenBaoClient(
      { url: 'http://openbao:8200', token: 'dev-root-token' },
      mockFetch as typeof fetch,
    );

    await client.ensureSecretsEngine();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('ensureSecretsEngine enables engine when missing', async () => {
    const mockFetch = mock();

    // First call: check mounts — no secret/ engine
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ 'sys/': { type: 'system' } }), {
        status: 200,
      }),
    );
    // Second call: enable engine
    mockFetch.mockResolvedValueOnce(
      new Response(null, { status: 204 }),
    );

    const client = new OpenBaoClient(
      { url: 'http://openbao:8200', token: 'dev-root-token' },
      mockFetch as typeof fetch,
    );

    await client.ensureSecretsEngine();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test src/lib/services/__tests__/openbao-init.test.ts`
Expected: All tests pass (ensureSecretsEngine already implemented in Task 2)

- [ ] **Step 3: Create initialization service**

Create `src/lib/services/openbao-init.ts`:

```typescript
import type { OpenBaoClient } from '@/lib/clients/openbao-client';

let initialized = false;

/**
 * Initialize OpenBao for first use.
 * Ensures the KV v2 secrets engine is enabled at the `secret/` path.
 * Safe to call multiple times — only runs once per process lifetime.
 */
export async function initializeOpenBao(client: OpenBaoClient): Promise<void> {
  if (initialized) {
    return;
  }

  try {
    await client.ensureSecretsEngine();
    initialized = true;
  } catch (error) {
    console.error(
      'Failed to initialize OpenBao secrets engine:',
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

/**
 * Reset initialization state (for testing only).
 */
export function resetOpenBaoInitState(): void {
  initialized = false;
}
```

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/openbao-init.ts src/lib/services/__tests__/openbao-init.test.ts
git commit -m "feat(openbao): add initialization service for KV v2 engine setup"
```

---

## Chunk 6: Final Verification

### Task 10: Full test suite & typecheck

- [ ] **Step 1: Run all OpenBao tests**

Run: `bun test src/lib/config/__tests__/openbao-config.test.ts src/lib/clients/__tests__/openbao-client.test.ts src/lib/services/__tests__/openbao-secret-resolver.test.ts src/lib/services/__tests__/secret-resolver-factory.test.ts src/lib/server-functions/__tests__/openbao-server-functions.test.ts src/lib/services/__tests__/openbao-init.test.ts src/middleware/__tests__/openbao-middleware.test.ts`
Expected: All tests pass

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All tests pass, coverage thresholds met (95% functions / 99% lines)

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 4: Commit any remaining fixes**

If any tests or typecheck issues arose, fix and commit:

```bash
git add -A
git commit -m "fix(openbao): address test and typecheck issues"
```

---

## Summary of Files

### New Files Created

| File | Purpose |
|------|---------|
| `src/lib/config/openbao-config.ts` | Zod-validated config from `OPENBAO_URL` + `OPENBAO_TOKEN` env vars |
| `src/lib/config/__tests__/openbao-config.test.ts` | Config loader tests |
| `src/lib/clients/openbao-client.ts` | Thin OpenBao KV v2 HTTP client (native fetch) |
| `src/lib/clients/__tests__/openbao-client.test.ts` | Client tests with mocked fetch |
| `src/lib/services/secret-resolver.ts` | SecretResolver interface + NoOpSecretResolver |
| `src/lib/services/openbao-secret-resolver.ts` | OpenBao-backed SecretResolver implementation |
| `src/lib/services/__tests__/openbao-secret-resolver.test.ts` | SecretResolver tests |
| `src/lib/services/secret-resolver-factory.ts` | Factory: auto-selects resolver based on config |
| `src/lib/services/__tests__/secret-resolver-factory.test.ts` | Factory tests |
| `src/lib/services/openbao-init.ts` | One-time KV v2 engine initialization |
| `src/lib/services/__tests__/openbao-init.test.ts` | Init tests |
| `src/middleware/openbao-middleware.ts` | TanStack middleware injecting OpenBaoClient |
| `src/middleware/__tests__/openbao-middleware.test.ts` | Middleware config tests |
| `src/lib/server-functions/openbao-server-functions.ts` | Server functions: list, get, set, delete secrets |
| `src/lib/server-functions/__tests__/openbao-server-functions.test.ts` | Server function logic tests |

### Modified Files

| File | Change |
|------|--------|
| `docker-compose.dev.yml` | Add OpenBao dev server with `management` profile |
| `.env.example` | Add `OPENBAO_URL` and `OPENBAO_TOKEN` examples |

### API Surface

| Server Function | Method | Input | Output |
|----------------|--------|-------|--------|
| `listStackSecrets` | GET | `{ stack }` | `string[]` (sorted key names, no values) |
| `getStackSecret` | GET | `{ stack, key }` | `{ value }` (single secret for reveal) |
| `setStackSecret` | POST | `{ stack, key, value }` | `{ success: true }` |
| `deleteStackSecret` | POST | `{ stack, key }` | `{ success: true }` |

### OpenBao KV v2 API Paths

| Operation | Method | Path |
|-----------|--------|------|
| List keys | LIST | `/v1/secret/metadata/stacks/{stack}` |
| Read secret | GET | `/v1/secret/data/stacks/{stack}/{key}` |
| Write secret | POST | `/v1/secret/data/stacks/{stack}/{key}` |
| Delete secret | DELETE | `/v1/secret/metadata/stacks/{stack}/{key}` |
| Check mounts | GET | `/v1/sys/mounts` |
| Enable engine | POST | `/v1/sys/mounts/secret` |
