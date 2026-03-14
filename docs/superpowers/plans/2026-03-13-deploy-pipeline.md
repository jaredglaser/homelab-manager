# Deploy Pipeline Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the trigger-agnostic deploy pipeline that validates, resolves secrets, dispatches to agents, and records deploy results. This includes the agent HTTP client, trigger builders (git push + UI), deploy history database tables, change detection, and concurrency control.

**Architecture:** The deploy pipeline receives a `DeployRequest` from any trigger source (git push, UI action), validates it against the manifest and managed hosts, optionally resolves secrets via a pluggable interface (no-op default, OpenBao added later), dispatches the compose file + env to the agent container via HTTP, and records the result in PostgreSQL. Concurrency is enforced at the database level -- one deploy per stack at a time, with deduplication of pending requests.

**Tech Stack:** Bun runtime, `pg` (PostgreSQL client), `bun:test` + dependency injection for testing, `@/` imports, feature-flagged behind `DOCKER_MANAGEMENT_FEATURE_FLAG`

**Spec:** `docs/superpowers/specs/2026-03-13-docker-stack-management-design.md` (Section 3: Deploy Pipeline, Section 5: managed_hosts schema)

---

## Chunk 1: Types & Interfaces

### Task 1: Define deploy pipeline types

**Files:**
- Create: `src/lib/deploy/types.ts`

- [ ] **Step 1: Write type definitions**

```typescript
// src/lib/deploy/types.ts

export type DeployAction = 'deploy' | 'teardown' | 'restart';

export type DeployStatus =
  | 'pending'
  | 'in_progress'
  | 'succeeded'
  | 'failed'
  | 'no_change';

export type DeployTrigger = 'git_push' | 'ui' | 'manual_rollback';

export interface DeployRequest {
  stack: string;
  host: string;
  composeContent: string;
  commitSha: string;
  envContent: string;
  action: DeployAction;
  trigger: DeployTrigger;
  autoApproved: boolean;
}

export interface DeployRecord {
  id: number;
  stack: string;
  host: string;
  commitSha: string;
  composeHash: string;
  envHash: string;
  status: DeployStatus;
  trigger: DeployTrigger;
  logs: string | null;
  createdAt: Date;
}

export interface ManagedHost {
  id: number;
  name: string;
  agentUrl: string;
  agentTokenHash: string;
  socketProxyUrl: string;
  agentVersion: string | null;
  status: string;
  createdAt: Date;
}

export interface ManifestEntry {
  host: string;
  autoDeploy: boolean;
}

export interface Manifest {
  stacks: Record<string, ManifestEntry>;
}

/**
 * Secret resolver interface. The no-op implementation returns an empty record.
 * The OpenBao plan provides a real implementation.
 */
export interface SecretResolver {
  resolve(stack: string, variables: string[]): Promise<Record<string, string>>;
}

export interface AgentDeployPayload {
  stack: string;
  composeContent: string;
  envContent: string;
  action: DeployAction;
}

export interface AgentDeployResponse {
  success: boolean;
  logs: string;
}
```

- [ ] **Step 2: Verify typecheck passes**

```bash
bun run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/deploy/types.ts
git commit -m "feat(deploy): add deploy pipeline type definitions"
```

---

## Chunk 2: Database Migration -- `managed_hosts` & `deploy_history`

### Task 2: Create migration file

**Files:**
- Create: `migrations/009_deploy_pipeline.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- migrations/009_deploy_pipeline.sql

-- Managed Docker hosts with agent connections
CREATE TABLE IF NOT EXISTS managed_hosts (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  agent_url TEXT NOT NULL,
  agent_token_hash TEXT NOT NULL,
  socket_proxy_url TEXT NOT NULL,
  agent_version TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Deploy history for stack deployments
CREATE TABLE IF NOT EXISTS deploy_history (
  id SERIAL PRIMARY KEY,
  stack TEXT NOT NULL,
  host TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  compose_hash TEXT NOT NULL,
  env_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  trigger TEXT NOT NULL,
  logs TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for querying deploys by stack (concurrency checks, history)
CREATE INDEX IF NOT EXISTS idx_deploy_history_stack_status
  ON deploy_history (stack, status, created_at DESC);

-- Index for querying deploys by host
CREATE INDEX IF NOT EXISTS idx_deploy_history_host
  ON deploy_history (host, created_at DESC);

-- Index for finding the latest deploy per stack (change detection)
CREATE INDEX IF NOT EXISTS idx_deploy_history_latest
  ON deploy_history (stack, host, created_at DESC)
  WHERE status = 'succeeded';
```

- [ ] **Step 2: Commit**

```bash
git add migrations/009_deploy_pipeline.sql
git commit -m "feat(deploy): add managed_hosts and deploy_history migrations"
```

---

## Chunk 3: Deploy Repository

### Task 3: Create deploy repository with tests

**Files:**
- Create: `src/lib/database/repositories/__tests__/deploy-repository.test.ts`
- Create: `src/lib/database/repositories/deploy-repository.ts`

- [ ] **Step 1: Write failing tests for DeployRepository**

```typescript
// src/lib/database/repositories/__tests__/deploy-repository.test.ts

import { describe, it, expect, beforeEach } from 'bun:test';
import { DeployRepository } from '../deploy-repository';
import type { DeployStatus, DeployTrigger } from '@/lib/deploy/types';

interface QueryCall {
  sql: string;
  params: unknown[];
}

function createMockPool(defaultRows: Record<string, unknown>[] = []) {
  const queries: QueryCall[] = [];
  const queuedResults: Record<string, unknown>[][] = [];

  return {
    pool: {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params: params ?? [] });
        const result = queuedResults.length > 0 ? queuedResults.shift()! : defaultRows;
        return { rows: result };
      },
    } as any,
    queries,
    pushResult(r: Record<string, unknown>[]) {
      queuedResults.push(r);
    },
  };
}

describe('DeployRepository', () => {
  let repo: DeployRepository;
  let mock: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    mock = createMockPool();
    repo = new DeployRepository(mock.pool);
  });

  describe('insertDeploy', () => {
    it('inserts a deploy record and returns the id', async () => {
      mock.pushResult([{ id: '42' }]);
      const id = await repo.insertDeploy({
        stack: 'plex',
        host: 'homeserver',
        commitSha: 'abc123',
        composeHash: 'hash1',
        envHash: 'hash2',
        status: 'pending',
        trigger: 'git_push',
      });

      expect(id).toBe(42);
      expect(mock.queries[0].sql).toContain('INSERT INTO deploy_history');
      expect(mock.queries[0].params).toEqual([
        'plex', 'homeserver', 'abc123', 'hash1', 'hash2', 'pending', 'git_push',
      ]);
    });
  });

  describe('updateStatus', () => {
    it('updates status and logs for a deploy record', async () => {
      await repo.updateStatus(42, 'succeeded', 'deployment complete');

      expect(mock.queries[0].sql).toContain('UPDATE deploy_history');
      expect(mock.queries[0].params).toEqual([42, 'succeeded', 'deployment complete']);
    });
  });

  describe('getLatestSuccessful', () => {
    it('returns null when no successful deploy exists', async () => {
      mock.pushResult([]);
      const result = await repo.getLatestSuccessful('plex', 'homeserver');
      expect(result).toBeNull();
    });

    it('returns the latest successful deploy with Number-coerced id', async () => {
      mock.pushResult([{
        id: '10',
        stack: 'plex',
        host: 'homeserver',
        commit_sha: 'abc123',
        compose_hash: 'hash1',
        env_hash: 'hash2',
        status: 'succeeded',
        trigger: 'git_push',
        logs: 'ok',
        created_at: new Date('2026-01-01'),
      }]);

      const result = await repo.getLatestSuccessful('plex', 'homeserver');
      expect(result).not.toBeNull();
      expect(result!.id).toBe(10);
      expect(result!.stack).toBe('plex');
      expect(result!.composeHash).toBe('hash1');
    });
  });

  describe('hasActiveDeployForStack', () => {
    it('returns false when no active deploy exists', async () => {
      mock.pushResult([{ count: '0' }]);
      const result = await repo.hasActiveDeployForStack('plex');
      expect(result).toBe(false);
    });

    it('returns true when an active deploy exists', async () => {
      mock.pushResult([{ count: '1' }]);
      const result = await repo.hasActiveDeployForStack('plex');
      expect(result).toBe(true);
    });
  });

  describe('getDeployHistory', () => {
    it('returns deploy records for a stack ordered by created_at desc', async () => {
      mock.pushResult([
        {
          id: '2', stack: 'plex', host: 'homeserver', commit_sha: 'def456',
          compose_hash: 'h3', env_hash: 'h4', status: 'succeeded',
          trigger: 'ui', logs: null, created_at: new Date('2026-01-02'),
        },
        {
          id: '1', stack: 'plex', host: 'homeserver', commit_sha: 'abc123',
          compose_hash: 'h1', env_hash: 'h2', status: 'failed',
          trigger: 'git_push', logs: 'error', created_at: new Date('2026-01-01'),
        },
      ]);

      const records = await repo.getDeployHistory('plex', 50);
      expect(records).toHaveLength(2);
      expect(records[0].id).toBe(2);
      expect(records[1].id).toBe(1);
    });
  });

  describe('deduplicatePending', () => {
    it('deletes older pending deploys for the same stack, keeping the latest', async () => {
      mock.pushResult([]);
      await repo.deduplicatePending('plex', 42);

      expect(mock.queries[0].sql).toContain('DELETE FROM deploy_history');
      expect(mock.queries[0].params).toEqual(['plex', 'pending', 42]);
    });
  });

  describe('getPendingDeploys', () => {
    it('returns pending deploys ordered by created_at asc', async () => {
      mock.pushResult([
        {
          id: '5', stack: 'plex', host: 'homeserver', commit_sha: 'abc',
          compose_hash: 'h1', env_hash: 'h2', status: 'pending',
          trigger: 'git_push', logs: null, created_at: new Date('2026-01-01'),
        },
      ]);

      const records = await repo.getPendingDeploys();
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe(5);
      expect(records[0].status).toBe('pending');
    });
  });
});
```

- [ ] **Step 2: Run tests -- expect failure (module not found)**

```bash
bun test src/lib/database/repositories/__tests__/deploy-repository.test.ts
```

- [ ] **Step 3: Implement DeployRepository**

```typescript
// src/lib/database/repositories/deploy-repository.ts

import type { Pool } from 'pg';
import type { DeployRecord, DeployStatus, DeployTrigger } from '@/lib/deploy/types';

interface InsertDeployParams {
  stack: string;
  host: string;
  commitSha: string;
  composeHash: string;
  envHash: string;
  status: DeployStatus;
  trigger: DeployTrigger;
}

export class DeployRepository {
  constructor(private pool: Pool) {}

  async insertDeploy(params: InsertDeployParams): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO deploy_history (stack, host, commit_sha, compose_hash, env_hash, status, trigger)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [params.stack, params.host, params.commitSha, params.composeHash, params.envHash, params.status, params.trigger]
    );
    return Number(result.rows[0].id);
  }

  async updateStatus(id: number, status: DeployStatus, logs?: string): Promise<void> {
    await this.pool.query(
      `UPDATE deploy_history SET status = $2, logs = $3 WHERE id = $1`,
      [id, status, logs ?? null]
    );
  }

  async getLatestSuccessful(stack: string, host: string): Promise<DeployRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM deploy_history
       WHERE stack = $1 AND host = $2 AND status = 'succeeded'
       ORDER BY created_at DESC
       LIMIT 1`,
      [stack, host]
    );
    if (result.rows.length === 0) return null;
    return toDeployRecord(result.rows[0]);
  }

  async hasActiveDeployForStack(stack: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT COUNT(*) as count FROM deploy_history
       WHERE stack = $1 AND status IN ('pending', 'in_progress')`,
      [stack]
    );
    return Number(result.rows[0].count) > 0;
  }

  async getDeployHistory(stack: string, limit: number): Promise<DeployRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM deploy_history
       WHERE stack = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [stack, limit]
    );
    return result.rows.map(toDeployRecord);
  }

  async deduplicatePending(stack: string, keepId: number): Promise<void> {
    await this.pool.query(
      `DELETE FROM deploy_history
       WHERE stack = $1 AND status = $2 AND id != $3`,
      [stack, 'pending', keepId]
    );
  }

  async getPendingDeploys(): Promise<DeployRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM deploy_history
       WHERE status = 'pending'
       ORDER BY created_at ASC`
    );
    return result.rows.map(toDeployRecord);
  }
}

function toDeployRecord(row: Record<string, unknown>): DeployRecord {
  return {
    id: Number(row.id),
    stack: row.stack as string,
    host: row.host as string,
    commitSha: row.commit_sha as string,
    composeHash: row.compose_hash as string,
    envHash: row.env_hash as string,
    status: row.status as DeployRecord['status'],
    trigger: row.trigger as DeployRecord['trigger'],
    logs: (row.logs as string) ?? null,
    createdAt: row.created_at as Date,
  };
}
```

- [ ] **Step 4: Run tests -- expect all passing**

```bash
bun test src/lib/database/repositories/__tests__/deploy-repository.test.ts
```

- [ ] **Step 5: Verify typecheck**

```bash
bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/database/repositories/deploy-repository.ts src/lib/database/repositories/__tests__/deploy-repository.test.ts
git commit -m "feat(deploy): add DeployRepository with full test coverage"
```

---

## Chunk 4: Managed Hosts Repository

### Task 4: Create managed hosts repository with tests

**Files:**
- Create: `src/lib/database/repositories/__tests__/managed-hosts-repository.test.ts`
- Create: `src/lib/database/repositories/managed-hosts-repository.ts`

- [ ] **Step 1: Write failing tests for ManagedHostsRepository**

```typescript
// src/lib/database/repositories/__tests__/managed-hosts-repository.test.ts

import { describe, it, expect, beforeEach } from 'bun:test';
import { ManagedHostsRepository } from '../managed-hosts-repository';

interface QueryCall {
  sql: string;
  params: unknown[];
}

function createMockPool(defaultRows: Record<string, unknown>[] = []) {
  const queries: QueryCall[] = [];
  const queuedResults: Record<string, unknown>[][] = [];

  return {
    pool: {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params: params ?? [] });
        const result = queuedResults.length > 0 ? queuedResults.shift()! : defaultRows;
        return { rows: result };
      },
    } as any,
    queries,
    pushResult(r: Record<string, unknown>[]) {
      queuedResults.push(r);
    },
  };
}

describe('ManagedHostsRepository', () => {
  let repo: ManagedHostsRepository;
  let mock: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    mock = createMockPool();
    repo = new ManagedHostsRepository(mock.pool);
  });

  describe('getByName', () => {
    it('returns null when host does not exist', async () => {
      mock.pushResult([]);
      const result = await repo.getByName('nonexistent');
      expect(result).toBeNull();
    });

    it('returns the host with Number-coerced id', async () => {
      mock.pushResult([{
        id: '1',
        name: 'homeserver',
        agent_url: 'http://agent:9090',
        agent_token_hash: '$2b$hash',
        socket_proxy_url: 'tcp://proxy:2375',
        agent_version: '0.1.0',
        status: 'healthy',
        created_at: new Date('2026-01-01'),
      }]);

      const result = await repo.getByName('homeserver');
      expect(result).not.toBeNull();
      expect(result!.id).toBe(1);
      expect(result!.name).toBe('homeserver');
      expect(result!.agentUrl).toBe('http://agent:9090');
    });
  });

  describe('getAll', () => {
    it('returns all hosts', async () => {
      mock.pushResult([
        {
          id: '1', name: 'host1', agent_url: 'http://a:9090',
          agent_token_hash: 'h1', socket_proxy_url: 'tcp://p:2375',
          agent_version: null, status: 'healthy', created_at: new Date(),
        },
        {
          id: '2', name: 'host2', agent_url: 'http://b:9090',
          agent_token_hash: 'h2', socket_proxy_url: 'tcp://q:2375',
          agent_version: '0.2.0', status: 'pending', created_at: new Date(),
        },
      ]);

      const result = await repo.getAll();
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe(1);
      expect(result[1].id).toBe(2);
    });
  });

  describe('insert', () => {
    it('inserts a host and returns the id', async () => {
      mock.pushResult([{ id: '5' }]);
      const id = await repo.insert({
        name: 'newhost',
        agentUrl: 'http://agent:9090',
        agentTokenHash: '$2b$hash',
        socketProxyUrl: 'tcp://proxy:2375',
      });

      expect(id).toBe(5);
      expect(mock.queries[0].sql).toContain('INSERT INTO managed_hosts');
    });
  });

  describe('updateStatus', () => {
    it('updates host status', async () => {
      await repo.updateStatus(1, 'healthy');

      expect(mock.queries[0].sql).toContain('UPDATE managed_hosts');
      expect(mock.queries[0].params).toEqual([1, 'healthy']);
    });
  });

  describe('updateAgentVersion', () => {
    it('updates agent version', async () => {
      await repo.updateAgentVersion(1, '0.2.0');

      expect(mock.queries[0].sql).toContain('UPDATE managed_hosts');
      expect(mock.queries[0].params).toEqual([1, '0.2.0']);
    });
  });
});
```

- [ ] **Step 2: Run tests -- expect failure (module not found)**

```bash
bun test src/lib/database/repositories/__tests__/managed-hosts-repository.test.ts
```

- [ ] **Step 3: Implement ManagedHostsRepository**

```typescript
// src/lib/database/repositories/managed-hosts-repository.ts

import type { Pool } from 'pg';
import type { ManagedHost } from '@/lib/deploy/types';

interface InsertHostParams {
  name: string;
  agentUrl: string;
  agentTokenHash: string;
  socketProxyUrl: string;
}

export class ManagedHostsRepository {
  constructor(private pool: Pool) {}

  async getByName(name: string): Promise<ManagedHost | null> {
    const result = await this.pool.query(
      `SELECT * FROM managed_hosts WHERE name = $1`,
      [name]
    );
    if (result.rows.length === 0) return null;
    return toManagedHost(result.rows[0]);
  }

  async getAll(): Promise<ManagedHost[]> {
    const result = await this.pool.query(
      `SELECT * FROM managed_hosts ORDER BY name`
    );
    return result.rows.map(toManagedHost);
  }

  async insert(params: InsertHostParams): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO managed_hosts (name, agent_url, agent_token_hash, socket_proxy_url)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [params.name, params.agentUrl, params.agentTokenHash, params.socketProxyUrl]
    );
    return Number(result.rows[0].id);
  }

  async updateStatus(id: number, status: string): Promise<void> {
    await this.pool.query(
      `UPDATE managed_hosts SET status = $2 WHERE id = $1`,
      [id, status]
    );
  }

  async updateAgentVersion(id: number, version: string): Promise<void> {
    await this.pool.query(
      `UPDATE managed_hosts SET agent_version = $2 WHERE id = $1`,
      [id, version]
    );
  }
}

function toManagedHost(row: Record<string, unknown>): ManagedHost {
  return {
    id: Number(row.id),
    name: row.name as string,
    agentUrl: row.agent_url as string,
    agentTokenHash: row.agent_token_hash as string,
    socketProxyUrl: row.socket_proxy_url as string,
    agentVersion: (row.agent_version as string) ?? null,
    status: row.status as string,
    createdAt: row.created_at as Date,
  };
}
```

- [ ] **Step 4: Run tests -- expect all passing**

```bash
bun test src/lib/database/repositories/__tests__/managed-hosts-repository.test.ts
```

- [ ] **Step 5: Verify typecheck**

```bash
bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/database/repositories/managed-hosts-repository.ts src/lib/database/repositories/__tests__/managed-hosts-repository.test.ts
git commit -m "feat(deploy): add ManagedHostsRepository with full test coverage"
```

---

## Chunk 5: Agent Client

### Task 5: Create agent HTTP client with tests

**Files:**
- Create: `src/lib/clients/__tests__/agent-client.test.ts`
- Create: `src/lib/clients/agent-client.ts`

- [ ] **Step 1: Write failing tests for AgentClient**

```typescript
// src/lib/clients/__tests__/agent-client.test.ts

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { AgentClient, AgentClientError } from '../agent-client';

describe('AgentClient', () => {
  let client: AgentClient;
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    fetchMock = mock();
    client = new AgentClient({
      agentUrl: 'http://agent:9090',
      agentToken: 'test-token',
      timeoutMs: 5000,
      fetchFn: fetchMock as unknown as typeof fetch,
    });
  });

  describe('deploy', () => {
    it('sends POST to /stacks/deploy with correct headers and body', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, logs: 'deployed' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await client.deploy({
        stack: 'plex',
        composeContent: 'version: "3"',
        envContent: 'KEY=val',
        action: 'deploy',
      });

      expect(result.success).toBe(true);
      expect(result.logs).toBe('deployed');

      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('http://agent:9090/stacks/deploy');
      expect(options.method).toBe('POST');
      expect(options.headers['Authorization']).toBe('Bearer test-token');
      expect(options.headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(options.body);
      expect(body.stack).toBe('plex');
      expect(body.composeContent).toBe('version: "3"');
    });

    it('throws AgentClientError on non-200 response', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('Internal Server Error', { status: 500 })
      );

      await expect(client.deploy({
        stack: 'plex',
        composeContent: 'version: "3"',
        envContent: '',
        action: 'deploy',
      })).rejects.toThrow(AgentClientError);
    });

    it('throws AgentClientError on fetch failure (network error)', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(client.deploy({
        stack: 'plex',
        composeContent: 'version: "3"',
        envContent: '',
        action: 'deploy',
      })).rejects.toThrow(AgentClientError);
    });
  });

  describe('teardown', () => {
    it('sends POST to /stacks/teardown', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, logs: 'torn down' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await client.teardown('plex');
      expect(result.success).toBe(true);

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('http://agent:9090/stacks/teardown');
    });
  });

  describe('restart', () => {
    it('sends POST to /stacks/restart', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, logs: 'restarted' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await client.restart('plex');
      expect(result.success).toBe(true);

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('http://agent:9090/stacks/restart');
    });
  });

  describe('health', () => {
    it('returns health info from GET /health', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'healthy', version: '0.1.0' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await client.health();
      expect(result.status).toBe('healthy');
      expect(result.version).toBe('0.1.0');
    });

    it('throws AgentClientError when agent is unreachable', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(client.health()).rejects.toThrow(AgentClientError);
    });
  });
});
```

- [ ] **Step 2: Run tests -- expect failure (module not found)**

```bash
bun test src/lib/clients/__tests__/agent-client.test.ts
```

- [ ] **Step 3: Implement AgentClient**

```typescript
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
```

- [ ] **Step 4: Run tests -- expect all passing**

```bash
bun test src/lib/clients/__tests__/agent-client.test.ts
```

- [ ] **Step 5: Verify typecheck**

```bash
bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/clients/agent-client.ts src/lib/clients/__tests__/agent-client.test.ts
git commit -m "feat(deploy): add AgentClient HTTP wrapper with full test coverage"
```

---

## Chunk 6: Secret Resolver Interface & No-Op Implementation

### Task 6: Create secret resolver with tests

**Files:**
- Create: `src/lib/deploy/__tests__/secret-resolver.test.ts`
- Create: `src/lib/deploy/secret-resolver.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/lib/deploy/__tests__/secret-resolver.test.ts

import { describe, it, expect } from 'bun:test';
import { NoOpSecretResolver, extractVariableReferences } from '../secret-resolver';

describe('NoOpSecretResolver', () => {
  it('returns an empty record for any stack and variables', async () => {
    const resolver = new NoOpSecretResolver();
    const result = await resolver.resolve('plex', ['MY_SECRET', 'OTHER_VAR']);
    expect(result).toEqual({});
  });
});

describe('extractVariableReferences', () => {
  it('extracts ${VAR} references from compose content', () => {
    const compose = [
      'services:',
      '  plex:',
      '    environment:',
      '      - PLEX_TOKEN=${PLEX_TOKEN}',
      '      - TZ=${TIMEZONE}',
      '      - PLAIN_VALUE=hello',
      '    image: plexinc/pms-docker:${PLEX_VERSION}',
    ].join('\n');
    const vars = extractVariableReferences(compose);
    expect(vars).toEqual(['PLEX_TOKEN', 'TIMEZONE', 'PLEX_VERSION']);
  });

  it('returns empty array when no variables found', () => {
    const compose = [
      'services:',
      '  nginx:',
      '    image: nginx:latest',
    ].join('\n');
    const vars = extractVariableReferences(compose);
    expect(vars).toEqual([]);
  });

  it('deduplicates variable references', () => {
    const compose = [
      'services:',
      '  app:',
      '    environment:',
      '      - KEY=${SHARED}',
      '    labels:',
      '      - label=${SHARED}',
    ].join('\n');
    const vars = extractVariableReferences(compose);
    expect(vars).toEqual(['SHARED']);
  });

  it('handles ${VAR:-default} syntax by extracting just the variable name', () => {
    const compose = [
      'services:',
      '  app:',
      '    environment:',
      '      - PORT=${APP_PORT:-8080}',
    ].join('\n');
    const vars = extractVariableReferences(compose);
    expect(vars).toEqual(['APP_PORT']);
  });
});
```

- [ ] **Step 2: Run tests -- expect failure**

```bash
bun test src/lib/deploy/__tests__/secret-resolver.test.ts
```

- [ ] **Step 3: Implement secret resolver**

```typescript
// src/lib/deploy/secret-resolver.ts

import type { SecretResolver } from '@/lib/deploy/types';

/**
 * No-op secret resolver. Returns an empty record.
 * Used when OpenBao is not configured. The OpenBao plan
 * provides a real implementation that replaces this.
 */
export class NoOpSecretResolver implements SecretResolver {
  async resolve(_stack: string, _variables: string[]): Promise<Record<string, string>> {
    return {};
  }
}

/**
 * Extract ${VAR} references from Docker Compose content.
 * Supports ${VAR}, ${VAR:-default}, and ${VAR:+alternate} syntax.
 * Returns deduplicated variable names.
 */
export function extractVariableReferences(composeContent: string): string[] {
  const regex = /\$\{([A-Z_][A-Z0-9_]*)(?:[:?+-][^}]*)?\}/g;
  const vars = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(composeContent)) !== null) {
    vars.add(match[1]);
  }
  return Array.from(vars);
}
```

- [ ] **Step 4: Run tests -- expect all passing**

```bash
bun test src/lib/deploy/__tests__/secret-resolver.test.ts
```

- [ ] **Step 5: Verify typecheck**

```bash
bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/deploy/secret-resolver.ts src/lib/deploy/__tests__/secret-resolver.test.ts
git commit -m "feat(deploy): add SecretResolver interface with no-op default and variable extraction"
```

---

## Chunk 7: Change Detection

### Task 7: Create change detection utility with tests

**Files:**
- Create: `src/lib/deploy/__tests__/change-detection.test.ts`
- Create: `src/lib/deploy/change-detection.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/lib/deploy/__tests__/change-detection.test.ts

import { describe, it, expect } from 'bun:test';
import { computeHash, detectChanges } from '../change-detection';
import type { DeployRecord } from '@/lib/deploy/types';

describe('computeHash', () => {
  it('returns a consistent hex hash for the same input', () => {
    const hash1 = computeHash('hello world');
    const hash2 = computeHash('hello world');
    expect(hash1).toBe(hash2);
  });

  it('returns different hashes for different input', () => {
    const hash1 = computeHash('content a');
    const hash2 = computeHash('content b');
    expect(hash1).not.toBe(hash2);
  });

  it('returns a hex string', () => {
    const hash = computeHash('test');
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });
});

describe('detectChanges', () => {
  const baseRecord: DeployRecord = {
    id: 1,
    stack: 'plex',
    host: 'homeserver',
    commitSha: 'abc123',
    composeHash: computeHash('compose-v1'),
    envHash: computeHash('env-v1'),
    status: 'succeeded',
    trigger: 'git_push',
    logs: null,
    createdAt: new Date(),
  };

  it('returns changed=true when no previous deploy exists (first deploy)', () => {
    const result = detectChanges('compose-v1', 'env-v1', null);
    expect(result.changed).toBe(true);
    expect(result.composeHash).toBeTruthy();
    expect(result.envHash).toBeTruthy();
  });

  it('returns changed=false when compose and env are identical', () => {
    const result = detectChanges('compose-v1', 'env-v1', baseRecord);
    expect(result.changed).toBe(false);
  });

  it('returns changed=true when compose changed', () => {
    const result = detectChanges('compose-v2', 'env-v1', baseRecord);
    expect(result.changed).toBe(true);
  });

  it('returns changed=true when env changed', () => {
    const result = detectChanges('compose-v1', 'env-v2', baseRecord);
    expect(result.changed).toBe(true);
  });

  it('returns changed=true when both changed', () => {
    const result = detectChanges('compose-v2', 'env-v2', baseRecord);
    expect(result.changed).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests -- expect failure**

```bash
bun test src/lib/deploy/__tests__/change-detection.test.ts
```

- [ ] **Step 3: Implement change detection**

```typescript
// src/lib/deploy/change-detection.ts

import type { DeployRecord } from '@/lib/deploy/types';

/**
 * Compute a SHA-256 hex hash for content comparison.
 * Used for compose file and env content change detection.
 */
export function computeHash(content: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(content);
  return hasher.digest('hex');
}

interface ChangeDetectionResult {
  changed: boolean;
  composeHash: string;
  envHash: string;
}

/**
 * Compare compose content and env content against the last successful deploy.
 * First deploy (null previousDeploy) always returns changed: true.
 */
export function detectChanges(
  composeContent: string,
  envContent: string,
  previousDeploy: DeployRecord | null,
): ChangeDetectionResult {
  const composeHash = computeHash(composeContent);
  const envHash = computeHash(envContent);

  if (previousDeploy === null) {
    return { changed: true, composeHash, envHash };
  }

  const changed =
    composeHash !== previousDeploy.composeHash ||
    envHash !== previousDeploy.envHash;

  return { changed, composeHash, envHash };
}
```

- [ ] **Step 4: Run tests -- expect all passing**

```bash
bun test src/lib/deploy/__tests__/change-detection.test.ts
```

- [ ] **Step 5: Verify typecheck**

```bash
bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/deploy/change-detection.ts src/lib/deploy/__tests__/change-detection.test.ts
git commit -m "feat(deploy): add compose and env change detection with content hashing"
```

---

## Chunk 8: Trigger Builders

### Task 8: Create GitTriggerBuilder and UITriggerBuilder with tests

**Files:**
- Create: `src/lib/deploy/builders/__tests__/trigger-builders.test.ts`
- Create: `src/lib/deploy/builders/git-trigger-builder.ts`
- Create: `src/lib/deploy/builders/ui-trigger-builder.ts`
- Create: `src/lib/deploy/builders/index.ts`

- [ ] **Step 1: Write failing tests for both builders**

```typescript
// src/lib/deploy/builders/__tests__/trigger-builders.test.ts

import { describe, it, expect } from 'bun:test';
import { GitTriggerBuilder } from '../git-trigger-builder';
import { UITriggerBuilder } from '../ui-trigger-builder';
import type { Manifest } from '@/lib/deploy/types';

const testManifest: Manifest = {
  stacks: {
    plex: { host: 'homeserver', autoDeploy: true },
    traefik: { host: 'homeserver', autoDeploy: false },
    pihole: { host: 'pihole-host', autoDeploy: true },
  },
};

describe('GitTriggerBuilder', () => {
  const builder = new GitTriggerBuilder();

  it('builds DeployRequests for changed stacks with auto_deploy', () => {
    const changedStacks = new Map<string, string>([
      ['plex', 'version: "3"\nservices:\n  plex:\n    image: plexinc/pms-docker'],
      ['traefik', 'version: "3"\nservices:\n  traefik:\n    image: traefik:v3'],
    ]);

    const requests = builder.build({
      manifest: testManifest,
      changedStacks,
      commitSha: 'abc123',
    });

    // plex has autoDeploy: true -> autoApproved: true
    // traefik has autoDeploy: false -> autoApproved: false
    expect(requests).toHaveLength(2);

    const plexReq = requests.find(r => r.stack === 'plex')!;
    expect(plexReq.host).toBe('homeserver');
    expect(plexReq.commitSha).toBe('abc123');
    expect(plexReq.trigger).toBe('git_push');
    expect(plexReq.autoApproved).toBe(true);
    expect(plexReq.action).toBe('deploy');
    expect(plexReq.composeContent).toContain('plexinc/pms-docker');

    const traefikReq = requests.find(r => r.stack === 'traefik')!;
    expect(traefikReq.autoApproved).toBe(false);
  });

  it('skips stacks not in manifest', () => {
    const changedStacks = new Map<string, string>([
      ['unknown-stack', 'version: "3"'],
    ]);

    const requests = builder.build({
      manifest: testManifest,
      changedStacks,
      commitSha: 'abc123',
    });

    expect(requests).toHaveLength(0);
  });

  it('returns empty array when no stacks changed', () => {
    const requests = builder.build({
      manifest: testManifest,
      changedStacks: new Map(),
      commitSha: 'abc123',
    });

    expect(requests).toHaveLength(0);
  });
});

describe('UITriggerBuilder', () => {
  const builder = new UITriggerBuilder();

  it('builds a single DeployRequest for a UI deploy action', () => {
    const request = builder.build({
      stack: 'plex',
      host: 'homeserver',
      composeContent: 'version: "3"',
      commitSha: 'abc123',
      action: 'deploy',
    });

    expect(request.stack).toBe('plex');
    expect(request.host).toBe('homeserver');
    expect(request.trigger).toBe('ui');
    expect(request.autoApproved).toBe(true);
    expect(request.action).toBe('deploy');
  });

  it('builds a teardown request', () => {
    const request = builder.build({
      stack: 'plex',
      host: 'homeserver',
      composeContent: '',
      commitSha: 'abc123',
      action: 'teardown',
    });

    expect(request.action).toBe('teardown');
    expect(request.trigger).toBe('ui');
  });

  it('builds a manual_rollback request', () => {
    const request = builder.buildRollback({
      stack: 'plex',
      host: 'homeserver',
      composeContent: 'version: "3"',
      commitSha: 'old-sha',
    });

    expect(request.action).toBe('deploy');
    expect(request.trigger).toBe('manual_rollback');
    expect(request.commitSha).toBe('old-sha');
  });
});
```

- [ ] **Step 2: Run tests -- expect failure**

```bash
bun test src/lib/deploy/builders/__tests__/trigger-builders.test.ts
```

- [ ] **Step 3: Implement GitTriggerBuilder**

```typescript
// src/lib/deploy/builders/git-trigger-builder.ts

import type { DeployRequest, Manifest } from '@/lib/deploy/types';

interface GitTriggerInput {
  manifest: Manifest;
  /** Map of stack name -> compose file content for stacks with changed files */
  changedStacks: Map<string, string>;
  commitSha: string;
}

/**
 * Builds DeployRequests from a git push event.
 * Receives the set of changed stacks (determined by the git diff)
 * and the manifest. Produces one DeployRequest per changed stack
 * that exists in the manifest.
 */
export class GitTriggerBuilder {
  build(input: GitTriggerInput): DeployRequest[] {
    const requests: DeployRequest[] = [];

    for (const [stackName, composeContent] of input.changedStacks) {
      const manifestEntry = input.manifest.stacks[stackName];
      if (!manifestEntry) continue;

      requests.push({
        stack: stackName,
        host: manifestEntry.host,
        composeContent,
        commitSha: input.commitSha,
        envContent: '',
        action: 'deploy',
        trigger: 'git_push',
        autoApproved: manifestEntry.autoDeploy,
      });
    }

    return requests;
  }
}
```

- [ ] **Step 4: Implement UITriggerBuilder**

```typescript
// src/lib/deploy/builders/ui-trigger-builder.ts

import type { DeployAction, DeployRequest } from '@/lib/deploy/types';

interface UITriggerInput {
  stack: string;
  host: string;
  composeContent: string;
  commitSha: string;
  action: DeployAction;
}

interface UIRollbackInput {
  stack: string;
  host: string;
  composeContent: string;
  commitSha: string;
}

/**
 * Builds a DeployRequest from a UI action.
 * UI deploys are always auto-approved (the user clicked the button).
 */
export class UITriggerBuilder {
  build(input: UITriggerInput): DeployRequest {
    return {
      stack: input.stack,
      host: input.host,
      composeContent: input.composeContent,
      commitSha: input.commitSha,
      envContent: '',
      action: input.action,
      trigger: 'ui',
      autoApproved: true,
    };
  }

  buildRollback(input: UIRollbackInput): DeployRequest {
    return {
      stack: input.stack,
      host: input.host,
      composeContent: input.composeContent,
      commitSha: input.commitSha,
      envContent: '',
      action: 'deploy',
      trigger: 'manual_rollback',
      autoApproved: true,
    };
  }
}
```

- [ ] **Step 5: Create barrel export**

```typescript
// src/lib/deploy/builders/index.ts

export { GitTriggerBuilder } from './git-trigger-builder';
export { UITriggerBuilder } from './ui-trigger-builder';
```

- [ ] **Step 6: Run tests -- expect all passing**

```bash
bun test src/lib/deploy/builders/__tests__/trigger-builders.test.ts
```

- [ ] **Step 7: Verify typecheck**

```bash
bun run typecheck
```

- [ ] **Step 8: Commit**

```bash
git add src/lib/deploy/builders/
git commit -m "feat(deploy): add GitTriggerBuilder and UITriggerBuilder"
```

---

## Chunk 9: Deploy Pipeline

### Task 9: Create the deploy pipeline with tests

This is the core orchestration function. It validates, detects changes, resolves secrets, dispatches to the agent, and records the result.

**Files:**
- Create: `src/lib/deploy/__tests__/pipeline.test.ts`
- Create: `src/lib/deploy/pipeline.ts`

- [ ] **Step 1: Write failing tests for the pipeline**

```typescript
// src/lib/deploy/__tests__/pipeline.test.ts

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { DeployPipeline } from '../pipeline';
import type { DeployRecord, DeployRequest, ManagedHost, SecretResolver } from '@/lib/deploy/types';
import type { DeployRepository } from '@/lib/database/repositories/deploy-repository';
import type { ManagedHostsRepository } from '@/lib/database/repositories/managed-hosts-repository';
import type { AgentClient } from '@/lib/clients/agent-client';

function createMockDeployRepo(overrides: Partial<DeployRepository> = {}): DeployRepository {
  return {
    insertDeploy: mock().mockResolvedValue(1),
    updateStatus: mock().mockResolvedValue(undefined),
    getLatestSuccessful: mock().mockResolvedValue(null),
    hasActiveDeployForStack: mock().mockResolvedValue(false),
    deduplicatePending: mock().mockResolvedValue(undefined),
    getDeployHistory: mock().mockResolvedValue([]),
    getPendingDeploys: mock().mockResolvedValue([]),
    ...overrides,
  } as unknown as DeployRepository;
}

function createMockHostsRepo(host: ManagedHost | null = null): ManagedHostsRepository {
  return {
    getByName: mock().mockResolvedValue(host),
    getAll: mock().mockResolvedValue(host ? [host] : []),
    insert: mock().mockResolvedValue(1),
    updateStatus: mock().mockResolvedValue(undefined),
    updateAgentVersion: mock().mockResolvedValue(undefined),
  } as unknown as ManagedHostsRepository;
}

function createMockAgentClient(success = true): AgentClient {
  return {
    deploy: mock().mockResolvedValue({ success, logs: success ? 'deployed ok' : 'deploy failed' }),
    teardown: mock().mockResolvedValue({ success, logs: 'torn down' }),
    restart: mock().mockResolvedValue({ success, logs: 'restarted' }),
    health: mock().mockResolvedValue({ status: 'healthy', version: '0.1.0' }),
  } as unknown as AgentClient;
}

function createMockSecretResolver(): SecretResolver {
  return {
    resolve: mock().mockResolvedValue({}),
  };
}

const testHost: ManagedHost = {
  id: 1,
  name: 'homeserver',
  agentUrl: 'http://agent:9090',
  agentTokenHash: '$2b$hash',
  socketProxyUrl: 'tcp://proxy:2375',
  agentVersion: '0.1.0',
  status: 'healthy',
  createdAt: new Date(),
};

const testRequest: DeployRequest = {
  stack: 'plex',
  host: 'homeserver',
  composeContent: 'version: "3"\nservices:\n  plex:\n    image: plexinc/pms-docker',
  commitSha: 'abc123',
  envContent: '',
  action: 'deploy',
  trigger: 'git_push',
  autoApproved: true,
};

describe('DeployPipeline', () => {
  let deployRepo: ReturnType<typeof createMockDeployRepo>;
  let hostsRepo: ReturnType<typeof createMockHostsRepo>;
  let agentClientFactory: ReturnType<typeof mock>;
  let secretResolver: SecretResolver;
  let pipeline: DeployPipeline;

  beforeEach(() => {
    deployRepo = createMockDeployRepo();
    hostsRepo = createMockHostsRepo(testHost);
    const mockAgent = createMockAgentClient(true);
    agentClientFactory = mock().mockReturnValue(mockAgent);
    secretResolver = createMockSecretResolver();
    pipeline = new DeployPipeline({
      deployRepo: deployRepo as unknown as DeployRepository,
      hostsRepo: hostsRepo as unknown as ManagedHostsRepository,
      agentClientFactory,
      secretResolver,
    });
  });

  describe('execute', () => {
    it('runs the full pipeline for a deploy action', async () => {
      const result = await pipeline.execute(testRequest);

      expect(result.status).toBe('succeeded');
      expect(result.logs).toBe('deployed ok');
      expect(deployRepo.insertDeploy).toHaveBeenCalledTimes(1);
      expect(deployRepo.updateStatus).toHaveBeenCalledTimes(2); // in_progress + succeeded
    });

    it('returns no_change when compose and env are unchanged', async () => {
      const previousDeploy: DeployRecord = {
        id: 1,
        stack: 'plex',
        host: 'homeserver',
        commitSha: 'prev',
        composeHash: '',
        envHash: '',
        status: 'succeeded',
        trigger: 'git_push',
        logs: null,
        createdAt: new Date(),
      };
      // We need the hashes to match -- compute from the same content
      const { computeHash } = await import('../change-detection');
      previousDeploy.composeHash = computeHash(testRequest.composeContent);
      previousDeploy.envHash = computeHash(testRequest.envContent);

      deployRepo = createMockDeployRepo({
        getLatestSuccessful: mock().mockResolvedValue(previousDeploy) as any,
      });
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as ManagedHostsRepository,
        agentClientFactory,
        secretResolver,
      });

      const result = await pipeline.execute(testRequest);
      expect(result.status).toBe('no_change');
    });

    it('fails validation when host is not found', async () => {
      hostsRepo = createMockHostsRepo(null);
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as ManagedHostsRepository,
        agentClientFactory,
        secretResolver,
      });

      const result = await pipeline.execute(testRequest);
      expect(result.status).toBe('failed');
      expect(result.logs).toContain('not found');
    });

    it('rejects deploy when another deploy is active for the stack', async () => {
      deployRepo = createMockDeployRepo({
        hasActiveDeployForStack: mock().mockResolvedValue(true) as any,
      });
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as ManagedHostsRepository,
        agentClientFactory,
        secretResolver,
      });

      const result = await pipeline.execute(testRequest);
      expect(result.status).toBe('failed');
      expect(result.logs).toContain('active deploy');
    });

    it('creates a pending record for non-auto-approved requests', async () => {
      const manualRequest = { ...testRequest, autoApproved: false };
      const result = await pipeline.execute(manualRequest);

      expect(result.status).toBe('pending');
      expect(deployRepo.insertDeploy).toHaveBeenCalledTimes(1);
      // Should NOT have dispatched to agent
      expect(agentClientFactory).not.toHaveBeenCalled();
    });

    it('records failure when agent dispatch fails', async () => {
      const failAgent = createMockAgentClient(false);
      agentClientFactory = mock().mockReturnValue(failAgent);
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as ManagedHostsRepository,
        agentClientFactory,
        secretResolver,
      });

      const result = await pipeline.execute(testRequest);
      expect(result.status).toBe('failed');
    });

    it('handles teardown action', async () => {
      const teardownRequest = { ...testRequest, action: 'teardown' as const };
      const result = await pipeline.execute(teardownRequest);

      expect(result.status).toBe('succeeded');
      const agent = agentClientFactory.mock.results[0].value;
      expect(agent.teardown).toHaveBeenCalled();
    });

    it('handles restart action', async () => {
      const restartRequest = { ...testRequest, action: 'restart' as const };
      const result = await pipeline.execute(restartRequest);

      expect(result.status).toBe('succeeded');
      const agent = agentClientFactory.mock.results[0].value;
      expect(agent.restart).toHaveBeenCalled();
    });

    it('resolves secrets and builds env content', async () => {
      const composeWithVars = 'services:\n  app:\n    environment:\n      - TOKEN=${API_TOKEN}';
      const requestWithVars = { ...testRequest, composeContent: composeWithVars };

      const resolver: SecretResolver = {
        resolve: mock().mockResolvedValue({ API_TOKEN: 'secret-value' }),
      };
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as ManagedHostsRepository,
        agentClientFactory,
        secretResolver: resolver,
      });

      const result = await pipeline.execute(requestWithVars);
      expect(result.status).toBe('succeeded');
      expect(resolver.resolve).toHaveBeenCalledWith('plex', ['API_TOKEN']);
    });

    it('deduplicates pending deploys for the same stack', async () => {
      const result = await pipeline.execute(testRequest);
      expect(result.status).toBe('succeeded');
      expect(deployRepo.deduplicatePending).toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run tests -- expect failure**

```bash
bun test src/lib/deploy/__tests__/pipeline.test.ts
```

- [ ] **Step 3: Implement DeployPipeline**

```typescript
// src/lib/deploy/pipeline.ts

import type { AgentClient } from '@/lib/clients/agent-client';
import type { DeployRepository } from '@/lib/database/repositories/deploy-repository';
import type { ManagedHostsRepository } from '@/lib/database/repositories/managed-hosts-repository';
import type { DeployRequest, DeployStatus, ManagedHost, SecretResolver } from '@/lib/deploy/types';
import { detectChanges } from '@/lib/deploy/change-detection';
import { extractVariableReferences } from '@/lib/deploy/secret-resolver';

interface PipelineResult {
  status: DeployStatus;
  logs: string;
  deployId?: number;
}

interface PipelineDeps {
  deployRepo: DeployRepository;
  hostsRepo: ManagedHostsRepository;
  agentClientFactory: (agentUrl: string, agentToken: string) => AgentClient;
  secretResolver: SecretResolver;
}

/**
 * Trigger-agnostic deploy pipeline.
 * Validates -> detects changes -> resolves secrets -> dispatches to agent -> records result.
 */
export class DeployPipeline {
  private readonly deployRepo: DeployRepository;
  private readonly hostsRepo: ManagedHostsRepository;
  private readonly agentClientFactory: PipelineDeps['agentClientFactory'];
  private readonly secretResolver: SecretResolver;

  constructor(deps: PipelineDeps) {
    this.deployRepo = deps.deployRepo;
    this.hostsRepo = deps.hostsRepo;
    this.agentClientFactory = deps.agentClientFactory;
    this.secretResolver = deps.secretResolver;
  }

  async execute(request: DeployRequest): Promise<PipelineResult> {
    // 1. Validate: host exists in managed_hosts
    const host = await this.hostsRepo.getByName(request.host);
    if (!host) {
      return { status: 'failed', logs: `Host "${request.host}" not found in managed_hosts` };
    }

    // 2. Concurrency check: one deploy per stack at a time
    const hasActive = await this.deployRepo.hasActiveDeployForStack(request.stack);
    if (hasActive) {
      return { status: 'failed', logs: `Stack "${request.stack}" already has an active deploy` };
    }

    // 3. Change detection (skip for teardown/restart -- always execute those)
    let composeHash = '';
    let envHash = '';
    let resolvedEnvContent = request.envContent;

    if (request.action === 'deploy') {
      // Resolve secrets
      const variables = extractVariableReferences(request.composeContent);
      if (variables.length > 0) {
        const secrets = await this.secretResolver.resolve(request.stack, variables);
        resolvedEnvContent = buildEnvContent(request.envContent, secrets);
      }

      const previousDeploy = await this.deployRepo.getLatestSuccessful(request.stack, request.host);
      const changeResult = detectChanges(request.composeContent, resolvedEnvContent, previousDeploy);
      composeHash = changeResult.composeHash;
      envHash = changeResult.envHash;

      if (!changeResult.changed) {
        const deployId = await this.deployRepo.insertDeploy({
          stack: request.stack,
          host: request.host,
          commitSha: request.commitSha,
          composeHash,
          envHash,
          status: 'no_change',
          trigger: request.trigger,
        });
        return { status: 'no_change', logs: 'No changes detected, skipping deploy', deployId };
      }
    }

    // 4. Insert deploy record
    const deployId = await this.deployRepo.insertDeploy({
      stack: request.stack,
      host: request.host,
      commitSha: request.commitSha,
      composeHash,
      envHash,
      status: request.autoApproved ? 'in_progress' : 'pending',
      trigger: request.trigger,
    });

    // Deduplicate older pending deploys for this stack
    await this.deployRepo.deduplicatePending(request.stack, deployId);

    // 5. If not auto-approved, stop here (UI will show pending state)
    if (!request.autoApproved) {
      return { status: 'pending', logs: 'Awaiting manual approval', deployId };
    }

    // 6. Mark as in_progress
    await this.deployRepo.updateStatus(deployId, 'in_progress');

    // 7. Dispatch to agent
    return this.dispatch(host, request, resolvedEnvContent, deployId);
  }

  /**
   * Resume a pending deploy (after manual approval).
   */
  async resumePending(deployId: number, host: ManagedHost, request: DeployRequest): Promise<PipelineResult> {
    await this.deployRepo.updateStatus(deployId, 'in_progress');
    return this.dispatch(host, request, request.envContent, deployId);
  }

  private async dispatch(
    host: ManagedHost,
    request: DeployRequest,
    envContent: string,
    deployId: number,
  ): Promise<PipelineResult> {
    try {
      const agent = this.agentClientFactory(host.agentUrl, '');

      let result;
      switch (request.action) {
        case 'deploy':
          result = await agent.deploy({
            stack: request.stack,
            composeContent: request.composeContent,
            envContent,
            action: 'deploy',
          });
          break;
        case 'teardown':
          result = await agent.teardown(request.stack);
          break;
        case 'restart':
          result = await agent.restart(request.stack);
          break;
      }

      const finalStatus: DeployStatus = result.success ? 'succeeded' : 'failed';
      await this.deployRepo.updateStatus(deployId, finalStatus, result.logs);

      return { status: finalStatus, logs: result.logs, deployId };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.deployRepo.updateStatus(deployId, 'failed', errorMsg);
      return { status: 'failed', logs: errorMsg, deployId };
    }
  }
}

/**
 * Merge existing env content with resolved secrets.
 * Secrets are appended to the env content. Existing keys in envContent
 * are NOT overridden by secrets (explicit env takes precedence).
 */
function buildEnvContent(existingEnv: string, secrets: Record<string, string>): string {
  const lines = existingEnv ? existingEnv.split('\n').filter(l => l.trim()) : [];
  const existingKeys = new Set(
    lines
      .filter(l => l.includes('=') && !l.startsWith('#'))
      .map(l => l.split('=')[0].trim())
  );

  for (const [key, value] of Object.entries(secrets)) {
    if (!existingKeys.has(key)) {
      lines.push(`${key}=${value}`);
    }
  }

  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests -- expect all passing**

```bash
bun test src/lib/deploy/__tests__/pipeline.test.ts
```

- [ ] **Step 5: Verify typecheck**

```bash
bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/deploy/pipeline.ts src/lib/deploy/__tests__/pipeline.test.ts
git commit -m "feat(deploy): add deploy pipeline with validation, change detection, and agent dispatch"
```

---

## Chunk 10: Deploy Pipeline Barrel Export & Feature Flag Guard

### Task 10: Create barrel export and feature flag utility

**Files:**
- Create: `src/lib/deploy/index.ts`
- Create: `src/lib/deploy/feature-flag.ts`
- Create: `src/lib/deploy/__tests__/feature-flag.test.ts`

- [ ] **Step 1: Write failing tests for feature flag**

```typescript
// src/lib/deploy/__tests__/feature-flag.test.ts

import { describe, it, expect, afterEach } from 'bun:test';
import { isDockerManagementEnabled } from '../feature-flag';

describe('isDockerManagementEnabled', () => {
  const originalEnv = process.env.DOCKER_MANAGEMENT_FEATURE_FLAG;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DOCKER_MANAGEMENT_FEATURE_FLAG;
    } else {
      process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = originalEnv;
    }
  });

  it('returns false when env var is not set', () => {
    delete process.env.DOCKER_MANAGEMENT_FEATURE_FLAG;
    expect(isDockerManagementEnabled()).toBe(false);
  });

  it('returns true when env var is "true"', () => {
    process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'true';
    expect(isDockerManagementEnabled()).toBe(true);
  });

  it('returns false when env var is "false"', () => {
    process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'false';
    expect(isDockerManagementEnabled()).toBe(false);
  });

  it('returns false for any other value', () => {
    process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'yes';
    expect(isDockerManagementEnabled()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests -- expect failure**

```bash
bun test src/lib/deploy/__tests__/feature-flag.test.ts
```

- [ ] **Step 3: Implement feature flag**

```typescript
// src/lib/deploy/feature-flag.ts

/**
 * Check if Docker stack management feature is enabled.
 * Gated behind DOCKER_MANAGEMENT_FEATURE_FLAG=true env var.
 */
export function isDockerManagementEnabled(): boolean {
  return process.env.DOCKER_MANAGEMENT_FEATURE_FLAG === 'true';
}
```

- [ ] **Step 4: Create barrel export**

```typescript
// src/lib/deploy/index.ts

export { DeployPipeline } from './pipeline';
export { GitTriggerBuilder, UITriggerBuilder } from './builders';
export { NoOpSecretResolver, extractVariableReferences } from './secret-resolver';
export { computeHash, detectChanges } from './change-detection';
export { isDockerManagementEnabled } from './feature-flag';
export type {
  DeployAction,
  DeployStatus,
  DeployTrigger,
  DeployRequest,
  DeployRecord,
  ManagedHost,
  Manifest,
  ManifestEntry,
  SecretResolver,
  AgentDeployPayload,
  AgentDeployResponse,
} from './types';
```

- [ ] **Step 5: Run tests -- expect all passing**

```bash
bun test src/lib/deploy/__tests__/feature-flag.test.ts
```

- [ ] **Step 6: Verify typecheck and full test suite**

```bash
bun run typecheck && bun test
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/deploy/index.ts src/lib/deploy/feature-flag.ts src/lib/deploy/__tests__/feature-flag.test.ts
git commit -m "feat(deploy): add feature flag guard and barrel exports for deploy pipeline"
```

---

## Summary

| Chunk | What | Files |
|-------|------|-------|
| 1 | Types & interfaces | `src/lib/deploy/types.ts` |
| 2 | Database migration | `migrations/009_deploy_pipeline.sql` |
| 3 | Deploy repository | `src/lib/database/repositories/deploy-repository.ts` + tests |
| 4 | Managed hosts repository | `src/lib/database/repositories/managed-hosts-repository.ts` + tests |
| 5 | Agent HTTP client | `src/lib/clients/agent-client.ts` + tests |
| 6 | Secret resolver (no-op) | `src/lib/deploy/secret-resolver.ts` + tests |
| 7 | Change detection | `src/lib/deploy/change-detection.ts` + tests |
| 8 | Trigger builders | `src/lib/deploy/builders/*.ts` + tests |
| 9 | Deploy pipeline | `src/lib/deploy/pipeline.ts` + tests |
| 10 | Feature flag & barrel | `src/lib/deploy/feature-flag.ts`, `src/lib/deploy/index.ts` + tests |

**Total new files:** 19 (10 implementation + 7 test + 1 migration + 1 barrel)

**Integration points for other plans:**
- **Agent container plan** provides the HTTP server that `AgentClient` calls
- **Git management plan** uses `GitTriggerBuilder` in the post-receive hook
- **UI plan** uses `UITriggerBuilder` and the deploy pipeline via server functions
- **OpenBao plan** replaces `NoOpSecretResolver` with a real implementation
