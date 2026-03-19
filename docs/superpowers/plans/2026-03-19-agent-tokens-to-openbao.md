# Agent Tokens to OpenBao Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move agent tokens from plaintext DB columns to OpenBao secrets, drop both `agent_token` and `agent_token_hash` columns, and have the worker read tokens from OpenBao at startup.

**Architecture:** Add `getHostSecret`/`setHostSecret`/`deleteHostSecret` methods to OpenBaoClient for the `hosts/` path prefix. The `addHost` handler writes tokens to OpenBao; the worker initializes an OpenBao client and reads tokens per-host. DB migration drops both token columns.

**Tech Stack:** OpenBao KV v2, Bun, TypeScript, PostgreSQL migrations, bun:test

**Spec:** `docs/superpowers/specs/2026-03-18-agent-tokens-to-openbao-design.md`

---

### Task 1: Add host secret methods to OpenBaoClient

**Files:**
- Modify: `src/lib/clients/openbao-client.ts`
- Test: `src/lib/clients/__tests__/openbao-client.test.ts`

- [ ] **Step 1: Write failing tests for getHostSecret**

In `src/lib/clients/__tests__/openbao-client.test.ts`, add a new `describe('host secrets')` block after the existing `ensureSecretsEngine` tests. Follow the exact pattern used by the `getSecret` tests:

```typescript
describe('host secrets', () => {
  describe('getHostSecret', () => {
    test('reads secret value from hosts data path', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              data: { value: 'my-agent-token' },
              metadata: { version: 1 },
            },
          }),
          { status: 200 },
        ),
      );

      const value = await client.getHostSecret('homeserver', 'agent_token');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'http://openbao:8200/v1/secret/data/hosts/homeserver/agent_token',
      );
      expect(opts.method).toBe('GET');
      expect(value).toBe('my-agent-token');
    });

    test('returns null when secret does not exist (404)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 404 }),
      );

      const value = await client.getHostSecret('homeserver', 'agent_token');
      expect(value).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/clients/__tests__/openbao-client.test.ts --filter "host secrets"`
Expected: FAIL — `client.getHostSecret is not a function`

- [ ] **Step 3: Implement getHostSecret**

In `src/lib/clients/openbao-client.ts`, add after the `deleteSecret` method (around line 214):

```typescript
  /**
   * Get a host secret value. Returns null if not found.
   * Uses the hosts/ path prefix (parallel to stacks/ for stack secrets).
   */
  async getHostSecret(hostname: string, key: string): Promise<string | null> {
    this.validatePathSegment(hostname, 'hostname');
    this.validatePathSegment(key, 'key');

    const response = await this.request(
      `${this.url}/v1/secret/data/hosts/${hostname}/${key}`,
      {
        method: 'GET',
        headers: { 'X-Vault-Token': this.token },
      },
      'GET_HOST',
      `host "${hostname}" key "${key}"`,
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      await this.throwApiError(response, 'GET_HOST', `host "${hostname}" key "${key}"`);
    }

    const body = await this.parseJsonResponse(response, 'GET_HOST', `host "${hostname}" key "${key}"`) as
      { data?: { data?: { value?: unknown } } } | undefined;
    const value = body?.data?.data?.value;
    if (typeof value !== 'string') {
      throw new Error(
        `OpenBao GET_HOST failed for host "${hostname}" key "${key}": unexpected response shape`,
      );
    }
    return value;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/lib/clients/__tests__/openbao-client.test.ts --filter "host secrets"`
Expected: PASS

- [ ] **Step 5: Write failing tests for setHostSecret and deleteHostSecret**

Add to the `host secrets` describe block:

```typescript
  describe('setHostSecret', () => {
    test('writes secret value to hosts data path', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { version: 1 } }), { status: 200 }),
      );

      await client.setHostSecret('homeserver', 'agent_token', 'new-token');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'http://openbao:8200/v1/secret/data/hosts/homeserver/agent_token',
      );
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body as string)).toEqual({
        data: { value: 'new-token' },
      });
    });
  });

  describe('deleteHostSecret', () => {
    test('deletes host secret metadata and all versions', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 204 }),
      );

      await client.deleteHostSecret('homeserver', 'agent_token');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'http://openbao:8200/v1/secret/metadata/hosts/homeserver/agent_token',
      );
      expect(opts.method).toBe('DELETE');
    });

    test('does not throw on 404 (already deleted)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 404 }),
      );

      await expect(
        client.deleteHostSecret('homeserver', 'agent_token'),
      ).resolves.toBeUndefined();
    });
  });
```

- [ ] **Step 6: Implement setHostSecret and deleteHostSecret**

In `src/lib/clients/openbao-client.ts`, add after `getHostSecret`:

```typescript
  /**
   * Set or update a host secret value.
   */
  async setHostSecret(hostname: string, key: string, value: string): Promise<void> {
    this.validatePathSegment(hostname, 'hostname');
    this.validatePathSegment(key, 'key');

    const response = await this.request(
      `${this.url}/v1/secret/data/hosts/${hostname}/${key}`,
      {
        method: 'POST',
        headers: {
          'X-Vault-Token': this.token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ data: { value } }),
      },
      'SET_HOST',
      `host "${hostname}" key "${key}"`,
    );

    if (!response.ok) {
      await this.throwApiError(response, 'SET_HOST', `host "${hostname}" key "${key}"`);
    }
  }

  /**
   * Delete a host secret (metadata and all versions).
   * Does not throw if the secret does not exist.
   */
  async deleteHostSecret(hostname: string, key: string): Promise<void> {
    this.validatePathSegment(hostname, 'hostname');
    this.validatePathSegment(key, 'key');

    const response = await this.request(
      `${this.url}/v1/secret/metadata/hosts/${hostname}/${key}`,
      {
        method: 'DELETE',
        headers: { 'X-Vault-Token': this.token },
      },
      'DELETE_HOST',
      `host "${hostname}" key "${key}"`,
    );

    if (response.status === 404) {
      return;
    }

    if (!response.ok) {
      await this.throwApiError(response, 'DELETE_HOST', `host "${hostname}" key "${key}"`);
    }
  }
```

- [ ] **Step 7: Run all OpenBao client tests**

Run: `bun test src/lib/clients/__tests__/openbao-client.test.ts`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add src/lib/clients/openbao-client.ts src/lib/clients/__tests__/openbao-client.test.ts
git commit -m "feat(openbao): add host secret methods (getHostSecret, setHostSecret, deleteHostSecret)"
```

---

### Task 2: Database migration and type cleanup

**Files:**
- Create: `migrations/012_drop_agent_token_columns.sql`
- Modify: `src/lib/database/repositories/host-repository.ts`
- Modify: `src/lib/deploy/types.ts`
- Modify: `src/lib/hosts/host-utils.ts`
- Test: `src/lib/database/repositories/__tests__/host-repository.test.ts`
- Test: `src/lib/hosts/__tests__/host-utils.test.ts`

- [ ] **Step 1: Create migration**

Create `migrations/012_drop_agent_token_columns.sql`:

```sql
-- Drop agent token columns from managed_hosts.
-- Tokens are now stored in OpenBao at secret/hosts/<hostname>/agent_token.
ALTER TABLE managed_hosts DROP COLUMN IF EXISTS agent_token;
ALTER TABLE managed_hosts DROP COLUMN IF EXISTS agent_token_hash;
```

- [ ] **Step 2: Update ManagedHost type in host-repository.ts**

Remove `agent_token_hash` and `agent_token` from `ManagedHost` interface (lines 10-11). Remove them from `CreateHostInput` (lines 22-23). Remove them from `rowToHost` (lines 41-42). Update `create` SQL to remove the two columns and parameters. Remove the `updateTokenHash` method (lines 101-106).

After changes, `ManagedHost` should be:

```typescript
export interface ManagedHost {
  id: number;
  name: string;
  agent_url: string;
  socket_proxy_url: string;
  agent_version: string | null;
  status: HostStatus;
  created_at: Date;
  updated_at: Date;
}

export interface CreateHostInput {
  name: string;
  agent_url: string;
  socket_proxy_url: string;
}
```

And `create` method:

```typescript
async create(input: CreateHostInput): Promise<ManagedHost> {
  const result = await this.pool.query(
    `INSERT INTO managed_hosts (name, agent_url, socket_proxy_url)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [input.name, input.agent_url, input.socket_proxy_url]
  );
  return rowToHost(result.rows[0] as ManagedHost);
}
```

- [ ] **Step 3: Update ManagedHost in deploy/types.ts**

Remove `agentTokenHash: string` from the `ManagedHost` interface (line 55 in deploy/types.ts).

- [ ] **Step 4: Update host-utils.ts**

Delete the `ManagedHostPublic` type alias (line 25 in host-utils.ts). Change `toHostListItem` parameter type from `ManagedHostPublic` to `ManagedHost`:

```typescript
import type { ManagedHost } from '@/lib/database/repositories/host-repository';
// ... (remove the Omit type)

export function toHostListItem(
  row: ManagedHost,
  overrides?: { agentVersion?: string | null; status?: HostStatus },
): HostListItem {
```

Also remove the unused second import of `ManagedHost` if there's a duplicate.

- [ ] **Step 5: Update host-repository.test.ts**

Remove `agent_token_hash` and `agent_token` from all mock row objects and query assertions. Remove the `updateTokenHash` test. Update `create` test assertions to only check 3 params (name, agent_url, socket_proxy_url).

- [ ] **Step 6: Update host-utils.test.ts**

Remove `agent_token_hash` and `agent_token` from the `baseRow` object in the `toHostListItem` tests.

- [ ] **Step 7: Run tests**

Run: `bun test src/lib/database/repositories/__tests__/host-repository.test.ts src/lib/hosts/__tests__/host-utils.test.ts`
Expected: All pass

- [ ] **Step 8: Run typecheck**

Run: `bun run typecheck`
Expected: Will show errors in files not yet updated (hosts.functions.tsx, collector-factory.ts, etc.). That's expected — we fix those in subsequent tasks.

- [ ] **Step 9: Commit**

```bash
git add migrations/012_drop_agent_token_columns.sql src/lib/database/repositories/host-repository.ts src/lib/database/repositories/__tests__/host-repository.test.ts src/lib/deploy/types.ts src/lib/hosts/host-utils.ts src/lib/hosts/__tests__/host-utils.test.ts
git commit -m "feat(db): drop agent_token columns from managed_hosts (moved to OpenBao)"
```

---

### Task 3: Remove hashToken/verifyToken from token-service

**Files:**
- Modify: `src/lib/services/token-service.ts`
- Modify: `src/lib/services/__tests__/token-service.test.ts`

- [ ] **Step 1: Remove hashToken and verifyToken**

Update `src/lib/services/token-service.ts` to only contain `generateToken`:

```typescript
/**
 * Generate a new random agent token using crypto.randomUUID().
 */
export function generateToken(): string {
  return crypto.randomUUID();
}
```

- [ ] **Step 2: Update token-service.test.ts**

Remove tests for `hashToken` and `verifyToken`. Keep only `generateToken` tests.

- [ ] **Step 3: Run test**

Run: `bun test src/lib/services/__tests__/token-service.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/lib/services/token-service.ts src/lib/services/__tests__/token-service.test.ts
git commit -m "refactor: remove hashToken/verifyToken (tokens now stored in OpenBao)"
```

---

### Task 4: Update AgentStatsCollector to accept token as constructor param

**Files:**
- Modify: `src/worker/collectors/agent-stats-collector.ts`
- Modify: `src/worker/collectors/__tests__/agent-stats-collector.test.ts`

- [ ] **Step 1: Update constructor and collect()**

In `src/worker/collectors/agent-stats-collector.ts`:

Add `private readonly token: string` field. Add `token: string` parameter to constructor (after `host`, before `abortController`). Change line 52 from `this.host.agent_token` to `this.token`.

```typescript
export class AgentStatsCollector extends BaseCollector {
  readonly name: string;
  private readonly host: ManagedHost;
  private readonly token: string;
  private readonly fetchFn: FetchFn;
  private knownContainers = new Set<string>();

  constructor(
    db: DatabaseClient,
    config: WorkerConfig,
    host: ManagedHost,
    token: string,
    abortController?: AbortController,
    fetchFn?: FetchFn,
  ) {
    super(db, config, abortController);
    this.host = host;
    this.token = token;
    this.name = `AgentStatsCollector[${host.name}]`;
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }
```

And in `collect()`, change `this.host.agent_token` to `this.token`:

```typescript
    const response = await this.fetchFn(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
      signal: this.signal,
    });
```

- [ ] **Step 2: Update test file**

In `src/worker/collectors/__tests__/agent-stats-collector.test.ts`, update all `new AgentStatsCollector(...)` calls to pass a token string after the host param:

Find calls like `new AgentStatsCollector(mockDb, mockConfig, mockHost, controller, mockFetch)` and change to `new AgentStatsCollector(mockDb, mockConfig, mockHost, 'test-token', controller, mockFetch)`.

Also remove `agent_token` from the `mockHost` object if present.

- [ ] **Step 3: Run tests**

Run: `bun test src/worker/collectors/__tests__/agent-stats-collector.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/worker/collectors/agent-stats-collector.ts src/worker/collectors/__tests__/agent-stats-collector.test.ts
git commit -m "refactor(worker): AgentStatsCollector accepts token as constructor param"
```

---

### Task 5: Update collector-factory to accept getToken and wire to worker

**Files:**
- Modify: `src/worker/collector-factory.ts`
- Modify: `src/worker/collector.ts`
- Modify: `src/worker/__tests__/collector-factory.test.ts`
- Modify: `docker-compose.dev.yml`

- [ ] **Step 1: Update createCollectorsForManagedHosts signature**

In `src/worker/collector-factory.ts`, replace the `agent_token` check with a `getToken` parameter:

```typescript
export async function createCollectorsForManagedHosts(
  db: DatabaseClient,
  workerConfig: WorkerConfig,
  shutdownController: AbortController,
  stack: AsyncDisposableStack,
  isManagementEnabled: () => boolean,
  findAllHosts: () => Promise<ManagedHost[]>,
  getToken: (hostname: string) => Promise<string | null>,
): Promise<CollectorFactoryResult> {
  const collectors: BaseCollector[] = [];
  const runners: Promise<void>[] = [];

  if (!isManagementEnabled()) {
    return { collectors, runners };
  }

  const hosts = await findAllHosts();
  if (hosts.length === 0) {
    console.info('[Worker] Management feature enabled but no managed hosts found');
    return { collectors, runners };
  }

  console.info(`[Worker] Starting ${hosts.length} AgentStatsCollector(s) for managed hosts`);

  for (const host of hosts) {
    const token = await getToken(host.name);
    if (!token) {
      console.info(`[Worker] Skipping managed host ${host.name}: no token found in OpenBao`);
      continue;
    }

    console.info(`[Worker] Starting AgentStatsCollector for ${host.name} (${host.agent_url})`);
    const collector = stack.use(
      new AgentStatsCollector(db, workerConfig, host, token, shutdownController)
    );
    collectors.push(collector);
    runners.push(collector.run());
  }

  return { collectors, runners };
}
```

- [ ] **Step 2: Update worker collector.ts**

In `src/worker/collector.ts`, add OpenBao initialization before calling `createCollectorsForManagedHosts`. Add imports for `loadOpenBaoConfig`, `isOpenBaoConfigured`, and `OpenBaoClient`. Update the call to pass a `getToken` lambda:

```typescript
import { isDockerManagementEnabled } from '@/lib/config/feature-flags';
import { HostRepository } from '@/lib/database/repositories/host-repository';
// ... existing imports ...

// Inside main(), after createCollectors:

      // Also start AgentStatsCollectors for managed hosts (if feature flag is on)
      const hostRepo = new HostRepository(db.getPool());
      let getToken: ((hostname: string) => Promise<string | null>) | undefined;

      if (isDockerManagementEnabled()) {
        const { loadOpenBaoConfig } = await import('@/lib/config/openbao-config');
        const { OpenBaoClient } = await import('@/lib/clients/openbao-client');
        const baoConfig = loadOpenBaoConfig(); // throws ZodError if env vars missing
        const baoClient = new OpenBaoClient(baoConfig);
        await baoClient.ensureSecretsEngine();
        console.info('[Worker] OpenBao client initialized for managed host tokens');
        getToken = (hostname: string) => baoClient.getHostSecret(hostname, 'agent_token');
      }

      const { collectors: managedCollectors, runners: managedRunners } = await createCollectorsForManagedHosts(
        db, workerConfig, shutdownController, stack,
        isDockerManagementEnabled,
        () => hostRepo.findAll(),
        getToken ?? (() => Promise.resolve(null)),
      );
```

- [ ] **Step 3: Add OPENBAO env vars to worker in docker-compose.dev.yml**

In `docker-compose.dev.yml`, add to the worker service environment (around line 91):

```yaml
  worker:
    <<: *shared-dev
    container_name: homelab-worker
    mem_limit: 512m
    command: bun src/worker/collector.ts
    environment:
      <<: [*postgres-env, *docker-env, *zfs-env, *proxmox-env]
      POSTGRES_POOL_SIZE: ${POSTGRES_POOL_SIZE}
      WORKER_ENABLED: ${WORKER_ENABLED}
      WORKER_DOCKER_ENABLED: ${WORKER_DOCKER_ENABLED}
      WORKER_ZFS_ENABLED: ${WORKER_ZFS_ENABLED}
      WORKER_PROXMOX_ENABLED: ${WORKER_PROXMOX_ENABLED}
      WORKER_COLLECTION_INTERVAL_MS: ${WORKER_COLLECTION_INTERVAL_MS}
      DOCKER_MANAGEMENT_FEATURE_FLAG: ${DOCKER_MANAGEMENT_FEATURE_FLAG:-}
      OPENBAO_URL: ${OPENBAO_URL:-}
      OPENBAO_TOKEN: ${OPENBAO_TOKEN:-}
```

- [ ] **Step 4: Update collector-factory tests**

In `src/worker/__tests__/collector-factory.test.ts`:

1. Remove `agent_token_hash` and `agent_token` from `sampleManagedHost` fixture (these fields no longer exist on `ManagedHost`).
2. Add a `getToken` mock as the 7th parameter to ALL `createCollectorsForManagedHosts` calls.
3. For tests that expect collectors to be created, `getToken` should return a token: `mock(() => Promise.resolve('test-token'))`.
4. **Rewrite** the existing "skips managed hosts with no agent_token" test — the skip condition is now "OpenBao returns null for the host's token", not a field on the host object:

```typescript
it('skips managed hosts when OpenBao returns no token', async () => {
  const getToken = mock(() => Promise.resolve(null));
  const result = await createCollectorsForManagedHosts(
    mockDb, mockConfig, controller, disposableStack,
    () => true,
    () => Promise.resolve([sampleManagedHost]),
    getToken,
  );
  expect(result.collectors).toHaveLength(0);
  expect(getToken).toHaveBeenCalledWith(sampleManagedHost.name);
});
```

- [ ] **Step 5: Run tests**

Run: `bun test src/worker/__tests__/collector-factory.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/worker/collector-factory.ts src/worker/collector.ts src/worker/__tests__/collector-factory.test.ts docker-compose.dev.yml
git commit -m "feat(worker): read agent tokens from OpenBao at startup"
```

---

### Task 6: Update addHost and removeHost handlers for OpenBao

**Files:**
- Modify: `src/data/hosts.functions.tsx`
- Modify: `src/data/__tests__/hosts.functions.handlers.test.ts`
- Modify: `src/data/__tests__/hosts.functions.test.ts`

- [ ] **Step 1: Update HostRepo interface and handleAddHost deps**

In `src/data/hosts.functions.tsx`:

Remove `agent_token_hash` and `agent_token` from the `HostRepo` inline interface's return types and `create` input type.

Replace `hashToken` with `storeToken` and `deleteToken` in `handleAddHost` deps:

```typescript
export async function handleAddHost(
  deps: HostHandlerDeps & {
    provision: (socketProxyUrl: string, opts: { hostName: string; agentPort: number; agentToken: string; agentImage: string; socketProxyUrl: string }) => Promise<{ agentUrl: string }>;
    generateToken: () => string;
    storeToken: (hostname: string, token: string) => Promise<void>;
    deleteToken: (hostname: string) => Promise<void>;
    checkHealth: (url: string) => Promise<HealthCheckOutcome>;
    removeAgent: (socketProxyUrl: string, hostName: string) => Promise<void>;
  },
  data: { name: string; socketProxyUrl: string; agentPort: number },
): Promise<AddHostResult> {
```

- [ ] **Step 2: Update handleAddHost body**

Remove `hashToken` call. Change `repo.create` to not pass token fields. Add OpenBao write after DB insert, with rollback on failure:

```typescript
  const plainToken = deps.generateToken();

  const provisionResult = await deps.provision(data.socketProxyUrl, {
    hostName: data.name,
    agentPort: data.agentPort,
    agentToken: plainToken,
    agentImage: getAgentImage(),
    socketProxyUrl: data.socketProxyUrl,
  });

  const host = await deps.repo.create({
    name: data.name,
    agent_url: provisionResult.agentUrl,
    socket_proxy_url: data.socketProxyUrl,
  });

  // Store token in OpenBao (after DB insert so both can be rolled back)
  try {
    await deps.storeToken(data.name, plainToken);
  } catch (err) {
    // Roll back: delete DB record + remove container
    await deps.repo.delete(host.id);
    try {
      await deps.removeAgent(data.socketProxyUrl, data.name);
    } catch {
      // Best-effort container cleanup
    }
    throw new Error(
      `Failed to store agent token in OpenBao: ${err instanceof Error ? err.message : err}. Host record and container have been cleaned up.`
    );
  }

  const healthResult = await retryHealthCheck(deps.checkHealth, provisionResult.agentUrl, [500, 1000, 2000]);

  if (!healthResult.healthy) {
    // Roll back: delete OpenBao token + DB record + container
    try { await deps.deleteToken(data.name); } catch { /* best-effort */ }
    let cleanupSucceeded = true;
    try {
      await deps.removeAgent(data.socketProxyUrl, data.name);
    } catch (cleanupErr) {
      cleanupSucceeded = false;
      console.error(
        `[addHost] Failed to clean up agent container for ${data.name} after health check failure:`,
        cleanupErr instanceof Error ? cleanupErr.message : cleanupErr
      );
    }
    await deps.repo.delete(host.id);
    throw new Error(
      cleanupSucceeded
        ? `Agent provisioned but health check failed after 3 attempts: ${healthResult.error}. Host record, token, and container have been cleaned up.`
        : `Agent provisioned but health check failed after 3 attempts: ${healthResult.error}. Host record and token deleted but agent container cleanup failed — manual removal may be required.`
    );
  }
```

- [ ] **Step 3: Update handleRemoveHost to delete OpenBao secret**

Add `deleteToken` to the deps interface and call it:

```typescript
export async function handleRemoveHost(
  deps: HostHandlerDeps & {
    removeAgent: (socketProxyUrl: string, hostName: string) => Promise<void>;
    deleteToken: (hostname: string) => Promise<void>;
  },
  data: { hostId: number },
): Promise<{ success: boolean; containerRemoved: boolean; warning?: string }> {
  // ... existing code ...

  // Delete token from OpenBao (best-effort, orphaned secrets are harmless)
  try {
    await deps.deleteToken(host.name);
  } catch (err) {
    console.error(
      `[removeHost] Failed to delete OpenBao token for ${host.name}:`,
      err instanceof Error ? err.message : err
    );
  }

  await deps.repo.delete(data.hostId);
```

- [ ] **Step 4: Update addHost and removeHost server function wrappers**

In the `addHost` wrapper, replace `hashToken` with OpenBao operations:

```typescript
export const addHost = createServerFn()
  .inputValidator(addHostSchema)
  .handler(async ({ data }): Promise<AddHostResult> => {
    const baseDeps = await loadDeps();
    const { generateToken } = await import('@/lib/services/token-service');
    const { AgentProvisioningService } = await import('@/lib/services/agent-provisioning-service');
    const { checkAgentHealth } = await import('@/lib/services/agent-health-service');
    const { OpenBaoClient } = await import('@/lib/clients/openbao-client');
    const { loadOpenBaoConfig } = await import('@/lib/config/openbao-config');
    const baoClient = new OpenBaoClient(loadOpenBaoConfig());
    const provService = new AgentProvisioningService();
    return handleAddHost({
      ...baseDeps,
      generateToken,
      storeToken: (hostname, token) => baoClient.setHostSecret(hostname, 'agent_token', token),
      deleteToken: (hostname) => baoClient.deleteHostSecret(hostname, 'agent_token'),
      checkHealth: checkAgentHealth,
      provision: async (url, opts) => { const docker = await loadDockerClient(url); return provService.provision(docker, opts); },
      removeAgent: async (url, name) => { const docker = await loadDockerClient(url); await provService.removeAgent(docker, name); },
    }, data);
  });
```

In the `removeHost` wrapper, add `deleteToken`:

```typescript
export const removeHost = createServerFn()
  .inputValidator(removeHostSchema)
  .handler(async ({ data }): Promise<{ success: boolean; containerRemoved: boolean; warning?: string }> => {
    const baseDeps = await loadDeps();
    const { AgentProvisioningService } = await import('@/lib/services/agent-provisioning-service');
    const { OpenBaoClient } = await import('@/lib/clients/openbao-client');
    const { loadOpenBaoConfig } = await import('@/lib/config/openbao-config');
    const baoClient = new OpenBaoClient(loadOpenBaoConfig());
    const provService = new AgentProvisioningService();
    return handleRemoveHost({
      ...baseDeps,
      removeAgent: async (url, name) => { const docker = await loadDockerClient(url); await provService.removeAgent(docker, name); },
      deleteToken: (hostname) => baoClient.deleteHostSecret(hostname, 'agent_token'),
    }, data);
  });
```

- [ ] **Step 5: Update handler tests**

In `src/data/__tests__/hosts.functions.handlers.test.ts`:

Remove `hashToken` from `addDeps()`. Add `storeToken` and `deleteToken` mocks:

```typescript
function addDeps(repo?: Partial<HostRepo>) {
  return {
    ...baseDeps(repo),
    provision: mock(() => Promise.resolve({ agentUrl: 'http://192.168.1.10:9090' })),
    generateToken: () => 'mock-token',
    storeToken: mock(() => Promise.resolve()),
    deleteToken: mock(() => Promise.resolve()),
    checkHealth: mock((): Promise<HealthCheckOutcome> => Promise.resolve({ healthy: true, version: '1.0.0' })),
    removeAgent: mock(() => Promise.resolve()),
  };
}
```

Add test for OpenBao write failure rollback:

```typescript
it('rolls back on OpenBao write failure', async () => {
  const deps = addDeps();
  deps.storeToken = mock(() => Promise.reject(new Error('OpenBao unreachable')));
  await expect(
    handleAddHost(deps, { name: 'new', socketProxyUrl: 'tcp://x:2375', agentPort: 9090 })
  ).rejects.toThrow(/Failed to store agent token/);
  expect(deps.repo.delete).toHaveBeenCalledWith(1);
  expect(deps.removeAgent).toHaveBeenCalled();
});
```

Add `deleteToken` mock to `handleRemoveHost` tests and add a test for it:

```typescript
it('deletes token from OpenBao', async () => {
  const repo = mockRepo();
  const deleteToken = mock(() => Promise.resolve());
  const result = await handleRemoveHost(
    { ...baseDeps(), repo, removeAgent: mock(() => Promise.resolve()), deleteToken },
    { hostId: 1 },
  );
  expect(deleteToken).toHaveBeenCalledWith('test-host');
  expect(result.success).toBe(true);
});
```

Also update the `HostRepo` inline types in the mock to remove token fields.

- [ ] **Step 6: Update hosts.functions.test.ts type assertions**

Remove `agent_token_hash` and `agent_token` from HostListItem type assertion objects and any `HostRepo` references.

- [ ] **Step 7: Run all tests and typecheck**

Run: `bun run typecheck && bun test`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add src/data/hosts.functions.tsx src/data/__tests__/hosts.functions.handlers.test.ts src/data/__tests__/hosts.functions.test.ts
git commit -m "feat(hosts): store/delete agent tokens in OpenBao instead of database"
```

---

### Task 7: Update mock functions and remaining references

**Files:**
- Modify: `src/lib/mock/functions/hosts.functions.ts`
- Modify: `src/components/stacks/__tests__/ComposeEditor.test.tsx` (if referencing token fields)

- [ ] **Step 1: Update mock hosts.functions.ts**

Remove any `agent_token` or `agent_token_hash` references from mock host objects and function signatures.

- [ ] **Step 2: Run full test suite and coverage**

Run: `bun run typecheck && bun test`
Expected: All pass, no type errors

Run: `bun test --coverage 2>&1 | node scripts/check-coverage.js`
Expected: Coverage thresholds met (96% functions / 99% lines)

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: clean up remaining token field references"
```

---

### Task 8: Final verification

- [ ] **Step 1: Full build**

Run: `bun run build`
Expected: Build succeeds

- [ ] **Step 2: Push**

```bash
git push origin docker-mgmt/5-hosts-worker-ui
```
