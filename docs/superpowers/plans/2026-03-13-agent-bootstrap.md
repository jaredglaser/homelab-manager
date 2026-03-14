# Agent Bootstrap & Host Management Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the database-backed host management subsystem that provisions agent containers on Docker hosts via socket proxy, manages authentication tokens, and exposes server functions for host CRUD operations, health checks, and agent updates.

**Architecture:** Managed hosts are stored in a PostgreSQL `managed_hosts` table. When a user adds a host, homelab-manager connects to the host's Docker socket proxy via Dockerode, pulls/creates the agent container, generates a bearer token (stored as bcrypt hash), and records the host. All subsequent communication goes through the agent's HTTP API. Agent updates bypass the agent by connecting directly to the socket proxy. The entire subsystem is gated behind `DOCKER_MANAGEMENT_FEATURE_FLAG=true`.

**Tech Stack:** PostgreSQL (pg), Dockerode, Bun built-in bcrypt (`Bun.password.hash`/`Bun.password.verify`), `createServerFn()` (TanStack Start), Zod validation, `bun:test`

**Spec:** `docs/superpowers/specs/2026-03-13-docker-stack-management-design.md` (Section 5: Agent Bootstrap & Host Management)

---

## Chunk 1: Database Migration & Host Repository

### Task 1: Create managed_hosts migration

**Files:**
- Create: `migrations/009_managed_hosts.sql`

- [ ] **Step 1: Create `migrations/009_managed_hosts.sql`**

```sql
-- Managed Docker hosts for agent-based stack management
-- Feature-flagged behind DOCKER_MANAGEMENT_FEATURE_FLAG
CREATE TABLE IF NOT EXISTS managed_hosts (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  agent_url TEXT NOT NULL,
  agent_token_hash TEXT NOT NULL,
  socket_proxy_url TEXT NOT NULL,
  agent_version TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- [ ] **Step 2: Verify migration SQL syntax**

Run: `cd /home/jared/homelab-manager && cat migrations/009_managed_hosts.sql`
Expected: Valid SQL with no syntax errors

- [ ] **Step 3: Commit**

```bash
git add migrations/009_managed_hosts.sql
git commit -m "feat(db): add managed_hosts table migration for agent-based host management"
```

---

### Task 2: Host repository — types and basic CRUD

**Files:**
- Create: `src/lib/database/repositories/__tests__/host-repository.test.ts`
- Create: `src/lib/database/repositories/host-repository.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/database/repositories/__tests__/host-repository.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'bun:test';
import { HostRepository } from '../host-repository';
import type { ManagedHost, CreateHostInput } from '../host-repository';

function createMockPool() {
  const queries: { sql: string; params: unknown[] }[] = [];
  const queryResults: Record<string, unknown>[][] = [];
  return {
    pool: {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params: params ?? [] });
        const result = queryResults.length > 0 ? queryResults.shift()! : [];
        return { rows: result, rowCount: result.length };
      },
    } as any,
    queries,
    pushResult(r: Record<string, unknown>[]) {
      queryResults.push(r);
    },
  };
}

const sampleHost: ManagedHost = {
  id: 1,
  name: 'homeserver',
  agent_url: 'http://192.168.1.10:9090',
  agent_token_hash: '$2b$10$hashedtoken',
  socket_proxy_url: 'tcp://192.168.1.10:2375',
  agent_version: '0.1.0',
  status: 'online',
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
};

const sampleRow = {
  id: 1, // SERIAL (INT4) returns number from node-postgres (only BIGINT returns strings)
  name: 'homeserver',
  agent_url: 'http://192.168.1.10:9090',
  agent_token_hash: '$2b$10$hashedtoken',
  socket_proxy_url: 'tcp://192.168.1.10:2375',
  agent_version: '0.1.0',
  status: 'online',
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
};

describe('HostRepository', () => {
  let repo: HostRepository;
  let mock: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    mock = createMockPool();
    repo = new HostRepository(mock.pool);
  });

  describe('create', () => {
    it('inserts a host and returns it with the generated id', async () => {
      mock.pushResult([sampleRow]);

      const input: CreateHostInput = {
        name: 'homeserver',
        agent_url: 'http://192.168.1.10:9090',
        agent_token_hash: '$2b$10$hashedtoken',
        socket_proxy_url: 'tcp://192.168.1.10:2375',
      };

      const result = await repo.create(input);

      expect(result.id).toBe(1);
      expect(result.name).toBe('homeserver');
      expect(result.agent_url).toBe('http://192.168.1.10:9090');
      expect(result.status).toBe('online');
      expect(mock.queries[0].sql).toContain('INSERT INTO managed_hosts');
      expect(mock.queries[0].sql).toContain('RETURNING');
      expect(mock.queries[0].params).toContain('homeserver');
    });
  });

  describe('findAll', () => {
    it('returns empty array when no hosts exist', async () => {
      mock.pushResult([]);
      const result = await repo.findAll();
      expect(result).toEqual([]);
    });

    it('returns all hosts sorted by name', async () => {
      mock.pushResult([
        { ...sampleRow, name: 'alpha' },
        { ...sampleRow, id: 2, name: 'beta' },
      ]);

      const result = await repo.findAll();

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('alpha');
      expect(result[1].name).toBe('beta');
      expect(result[0].id).toBe(1);
      expect(result[1].id).toBe(2);
    });
  });

  describe('findByName', () => {
    it('returns null when host does not exist', async () => {
      mock.pushResult([]);
      const result = await repo.findByName('nonexistent');
      expect(result).toBeNull();
    });

    it('returns host when found', async () => {
      mock.pushResult([sampleRow]);
      const result = await repo.findByName('homeserver');
      expect(result).not.toBeNull();
      expect(result!.name).toBe('homeserver');
      expect(result!.id).toBe(1);
    });
  });

  describe('findById', () => {
    it('returns null when id does not exist', async () => {
      mock.pushResult([]);
      const result = await repo.findById(999);
      expect(result).toBeNull();
    });

    it('returns host when found', async () => {
      mock.pushResult([sampleRow]);
      const result = await repo.findById(1);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(1);
    });
  });

  describe('updateStatus', () => {
    it('updates the status field and updated_at', async () => {
      mock.pushResult([]); // UPDATE returns no rows
      await repo.updateStatus(1, 'offline');
      expect(mock.queries[0].sql).toContain('UPDATE managed_hosts');
      expect(mock.queries[0].sql).toContain('updated_at');
      expect(mock.queries[0].params).toContain('offline');
      expect(mock.queries[0].params).toContain(1);
    });
  });

  describe('updateAgentVersion', () => {
    it('updates the agent_version field', async () => {
      mock.pushResult([]);
      await repo.updateAgentVersion(1, '0.2.0');
      expect(mock.queries[0].sql).toContain('UPDATE managed_hosts');
      expect(mock.queries[0].params).toContain('0.2.0');
      expect(mock.queries[0].params).toContain(1);
    });
  });

  describe('updateTokenHash', () => {
    it('updates the agent_token_hash field', async () => {
      mock.pushResult([]);
      await repo.updateTokenHash(1, '$2b$10$newhash');
      expect(mock.queries[0].sql).toContain('UPDATE managed_hosts');
      expect(mock.queries[0].params).toContain('$2b$10$newhash');
      expect(mock.queries[0].params).toContain(1);
    });
  });

  describe('delete', () => {
    it('deletes the host by id', async () => {
      mock.pushResult([]);
      await repo.delete(1);
      expect(mock.queries[0].sql).toContain('DELETE FROM managed_hosts');
      expect(mock.queries[0].params).toContain(1);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/jared/homelab-manager && bun test src/lib/database/repositories/__tests__/host-repository.test.ts`
Expected: FAIL — `host-repository` module not found

- [ ] **Step 3: Implement the host repository**

Create `src/lib/database/repositories/host-repository.ts`:

```typescript
import type { Pool } from 'pg';

export interface ManagedHost {
  id: number;
  name: string;
  agent_url: string;
  agent_token_hash: string;
  socket_proxy_url: string;
  agent_version: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreateHostInput {
  name: string;
  agent_url: string;
  agent_token_hash: string;
  socket_proxy_url: string;
}

// No separate ManagedHostRow needed — SERIAL (INT4) returns JavaScript numbers
// from node-postgres, unlike BIGINT which returns strings. The query result
// rows match ManagedHost directly.

function rowToHost(row: ManagedHost): ManagedHost {
  return {
    id: row.id,
    name: row.name,
    agent_url: row.agent_url,
    agent_token_hash: row.agent_token_hash,
    socket_proxy_url: row.socket_proxy_url,
    agent_version: row.agent_version,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class HostRepository {
  constructor(private pool: Pool) {}

  async create(input: CreateHostInput): Promise<ManagedHost> {
    const result = await this.pool.query(
      `INSERT INTO managed_hosts (name, agent_url, agent_token_hash, socket_proxy_url)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.name, input.agent_url, input.agent_token_hash, input.socket_proxy_url]
    );
    return rowToHost(result.rows[0] as ManagedHost);
  }

  async findAll(): Promise<ManagedHost[]> {
    const result = await this.pool.query(
      'SELECT * FROM managed_hosts ORDER BY name ASC'
    );
    return (result.rows as ManagedHost[]).map(rowToHost);
  }

  async findByName(name: string): Promise<ManagedHost | null> {
    const result = await this.pool.query(
      'SELECT * FROM managed_hosts WHERE name = $1',
      [name]
    );
    return result.rows.length > 0 ? rowToHost(result.rows[0] as ManagedHost) : null;
  }

  async findById(id: number): Promise<ManagedHost | null> {
    const result = await this.pool.query(
      'SELECT * FROM managed_hosts WHERE id = $1',
      [id]
    );
    return result.rows.length > 0 ? rowToHost(result.rows[0] as ManagedHost) : null;
  }

  async updateStatus(id: number, status: string): Promise<void> {
    await this.pool.query(
      'UPDATE managed_hosts SET status = $1, updated_at = NOW() WHERE id = $2',
      [status, id]
    );
  }

  async updateAgentVersion(id: number, version: string): Promise<void> {
    await this.pool.query(
      'UPDATE managed_hosts SET agent_version = $1, updated_at = NOW() WHERE id = $2',
      [version, id]
    );
  }

  async updateTokenHash(id: number, tokenHash: string): Promise<void> {
    await this.pool.query(
      'UPDATE managed_hosts SET agent_token_hash = $1, updated_at = NOW() WHERE id = $2',
      [tokenHash, id]
    );
  }

  async delete(id: number): Promise<void> {
    await this.pool.query(
      'DELETE FROM managed_hosts WHERE id = $1',
      [id]
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/jared/homelab-manager && bun test src/lib/database/repositories/__tests__/host-repository.test.ts`
Expected: All tests pass

- [ ] **Step 5: Run full test suite and typecheck**

Run: `cd /home/jared/homelab-manager && bun run typecheck && bun test`
Expected: No errors, all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/lib/database/repositories/host-repository.ts src/lib/database/repositories/__tests__/host-repository.test.ts
git commit -m "feat(hosts): add HostRepository with CRUD operations for managed_hosts table"
```

---

## Chunk 2: Token Generation & Feature Flag Config

### Task 3: Token generation utility

**Files:**
- Create: `src/lib/services/__tests__/token-service.test.ts`
- Create: `src/lib/services/token-service.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/services/__tests__/token-service.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { generateToken, hashToken, verifyToken } from '../token-service';

describe('token-service', () => {
  describe('generateToken', () => {
    it('returns a non-empty string', () => {
      const token = generateToken();
      expect(token).toBeTruthy();
      expect(typeof token).toBe('string');
    });

    it('returns unique tokens on each call', () => {
      const token1 = generateToken();
      const token2 = generateToken();
      expect(token1).not.toBe(token2);
    });

    it('returns a UUID-formatted string', () => {
      const token = generateToken();
      // UUID v4 format: 8-4-4-4-12 hex chars
      expect(token).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });
  });

  describe('hashToken', () => {
    it('returns a bcrypt hash string', async () => {
      const hash = await hashToken('test-token');
      expect(hash).toMatch(/^\$2[aby]?\$/);
    });

    it('produces different hashes for the same input (salted)', async () => {
      const hash1 = await hashToken('same-token');
      const hash2 = await hashToken('same-token');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('verifyToken', () => {
    it('returns true for matching token and hash', async () => {
      const token = 'my-secret-token';
      const hash = await hashToken(token);
      const result = await verifyToken(token, hash);
      expect(result).toBe(true);
    });

    it('returns false for non-matching token', async () => {
      const hash = await hashToken('correct-token');
      const result = await verifyToken('wrong-token', hash);
      expect(result).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/jared/homelab-manager && bun test src/lib/services/__tests__/token-service.test.ts`
Expected: FAIL — `token-service` module not found

- [ ] **Step 3: Implement the token service**

Create `src/lib/services/token-service.ts`:

```typescript
/**
 * Generate a new random agent token using crypto.randomUUID().
 */
export function generateToken(): string {
  return crypto.randomUUID();
}

/**
 * Hash a plaintext token using Bun's built-in bcrypt.
 * Returns a bcrypt hash string suitable for database storage.
 */
export async function hashToken(token: string): Promise<string> {
  return Bun.password.hash(token, {
    algorithm: 'bcrypt',
    cost: 10,
  });
}

/**
 * Verify a plaintext token against a bcrypt hash.
 * Returns true if the token matches.
 */
export async function verifyToken(token: string, hash: string): Promise<boolean> {
  return Bun.password.verify(token, hash);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/jared/homelab-manager && bun test src/lib/services/__tests__/token-service.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/token-service.ts src/lib/services/__tests__/token-service.test.ts
git commit -m "feat(hosts): add token generation and bcrypt hashing via Bun.password"
```

---

### Task 4: Feature flag config

**Files:**
- Create: `src/lib/config/__tests__/feature-flags.test.ts`
- Create: `src/lib/config/feature-flags.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/config/__tests__/feature-flags.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { isDockerManagementEnabled } from '../feature-flags';

describe('feature-flags', () => {
  const originalEnv = process.env.DOCKER_MANAGEMENT_FEATURE_FLAG;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DOCKER_MANAGEMENT_FEATURE_FLAG;
    } else {
      process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = originalEnv;
    }
  });

  describe('isDockerManagementEnabled', () => {
    it('returns false when env var is not set', () => {
      delete process.env.DOCKER_MANAGEMENT_FEATURE_FLAG;
      expect(isDockerManagementEnabled()).toBe(false);
    });

    it('returns false when env var is empty string', () => {
      process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = '';
      expect(isDockerManagementEnabled()).toBe(false);
    });

    it('returns false when env var is "false"', () => {
      process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'false';
      expect(isDockerManagementEnabled()).toBe(false);
    });

    it('returns true when env var is "true"', () => {
      process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'true';
      expect(isDockerManagementEnabled()).toBe(true);
    });

    it('returns false for any other value', () => {
      process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'yes';
      expect(isDockerManagementEnabled()).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/jared/homelab-manager && bun test src/lib/config/__tests__/feature-flags.test.ts`
Expected: FAIL — `feature-flags` module not found

- [ ] **Step 3: Implement the feature flag config**

Create `src/lib/config/feature-flags.ts`:

```typescript
/**
 * Check if Docker stack management feature is enabled.
 * Gated behind DOCKER_MANAGEMENT_FEATURE_FLAG=true env var.
 */
export function isDockerManagementEnabled(): boolean {
  return process.env.DOCKER_MANAGEMENT_FEATURE_FLAG === 'true';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/jared/homelab-manager && bun test src/lib/config/__tests__/feature-flags.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/lib/config/feature-flags.ts src/lib/config/__tests__/feature-flags.test.ts
git commit -m "feat(config): add Docker management feature flag check"
```

---

## Chunk 3: Agent Provisioning Service

### Task 5: Agent provisioning service — provision and remove

**Files:**
- Create: `src/lib/services/__tests__/agent-provisioning-service.test.ts`
- Create: `src/lib/services/agent-provisioning-service.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/services/__tests__/agent-provisioning-service.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { AgentProvisioningService } from '../agent-provisioning-service';
import type { ProvisionAgentOptions, ProvisionAgentResult } from '../agent-provisioning-service';

// Mock Dockerode for testing
function createMockDockerode() {
  const pulledImages: string[] = [];
  const createdContainers: { name: string; config: Record<string, unknown> }[] = [];
  const startedContainers: string[] = [];
  const stoppedContainers: string[] = [];
  const removedContainers: string[] = [];
  const inspectedContainers: string[] = [];
  let containerExists = false;
  let containerRunning = false;

  const mockContainer = {
    start: async () => {
      startedContainers.push('mock-container');
    },
    stop: async () => {
      stoppedContainers.push('mock-container');
    },
    remove: async () => {
      removedContainers.push('mock-container');
    },
    inspect: async () => {
      inspectedContainers.push('mock-container');
      if (!containerExists) {
        const err = new Error('No such container') as any;
        err.statusCode = 404;
        throw err;
      }
      return {
        State: { Running: containerRunning },
        Config: { Image: 'ghcr.io/org/homelab-manager-agent:latest' },
      };
    },
  };

  const docker = {
    pull: async (image: string) => {
      pulledImages.push(image);
      // Return a mock stream that resolves immediately
      return { pipe: () => {}, on: (_e: string, cb: () => void) => { if (_e === 'end') cb(); } };
    },
    createContainer: async (config: Record<string, unknown>) => {
      const name = (config.name as string) || 'unnamed';
      createdContainers.push({ name, config });
      return mockContainer;
    },
    getContainer: (_id: string) => mockContainer,
    modem: {
      followProgress: (stream: any, callback: (err: Error | null, output: unknown[]) => void) => {
        callback(null, []);
      },
    },
  } as any;

  return {
    docker,
    pulledImages,
    createdContainers,
    startedContainers,
    stoppedContainers,
    removedContainers,
    inspectedContainers,
    setContainerExists(exists: boolean) {
      containerExists = exists;
    },
    setContainerRunning(running: boolean) {
      containerRunning = running;
      containerExists = true;
    },
  };
}

describe('AgentProvisioningService', () => {
  let service: AgentProvisioningService;
  let mockDocker: ReturnType<typeof createMockDockerode>;

  const defaultOptions: ProvisionAgentOptions = {
    hostName: 'homeserver',
    agentPort: 9090,
    agentToken: 'test-token-uuid',
    agentImage: 'ghcr.io/org/homelab-manager-agent:latest',
    socketProxyUrl: 'tcp://192.168.1.10:2375',
  };

  beforeEach(() => {
    mockDocker = createMockDockerode();
    service = new AgentProvisioningService();
  });

  describe('provision', () => {
    it('pulls the agent image', async () => {
      await service.provision(mockDocker.docker, defaultOptions);
      expect(mockDocker.pulledImages).toContain('ghcr.io/org/homelab-manager-agent:latest');
    });

    it('creates a container with the correct name convention', async () => {
      await service.provision(mockDocker.docker, defaultOptions);
      expect(mockDocker.createdContainers).toHaveLength(1);
      expect(mockDocker.createdContainers[0].name).toBe('homelab-agent-homeserver');
    });

    it('passes AGENT_TOKEN and DOCKER_HOST as env vars', async () => {
      await service.provision(mockDocker.docker, defaultOptions);
      const config = mockDocker.createdContainers[0].config;
      const env = config.Env as string[];
      expect(env).toContainEqual('AGENT_TOKEN=test-token-uuid');
      expect(env).toContainEqual('DOCKER_HOST=tcp://192.168.1.10:2375');
      expect(env).toContainEqual('AGENT_PORT=9090');
    });

    it('mounts homelab-stacks volume', async () => {
      await service.provision(mockDocker.docker, defaultOptions);
      const config = mockDocker.createdContainers[0].config;
      const hostConfig = config.HostConfig as Record<string, unknown>;
      const binds = hostConfig.Binds as string[];
      expect(binds).toContainEqual('homelab-stacks:/opt/homelab-manager/stacks');
    });

    it('starts the container after creation', async () => {
      await service.provision(mockDocker.docker, defaultOptions);
      expect(mockDocker.startedContainers).toHaveLength(1);
    });

    it('returns the agent URL using host IP from socket proxy URL', async () => {
      const result = await service.provision(mockDocker.docker, defaultOptions);
      expect(result.containerName).toBe('homelab-agent-homeserver');
      expect(result.agentUrl).toBe('http://192.168.1.10:9090');
    });

    it('removes existing container before creating new one', async () => {
      mockDocker.setContainerRunning(true);
      await service.provision(mockDocker.docker, defaultOptions);
      expect(mockDocker.stoppedContainers).toHaveLength(1);
      expect(mockDocker.removedContainers).toHaveLength(1);
      expect(mockDocker.createdContainers).toHaveLength(1);
    });
  });

  describe('removeAgent', () => {
    it('stops and removes the container', async () => {
      mockDocker.setContainerRunning(true);
      await service.removeAgent(mockDocker.docker, 'homeserver');
      expect(mockDocker.stoppedContainers).toHaveLength(1);
      expect(mockDocker.removedContainers).toHaveLength(1);
    });

    it('handles container not found gracefully', async () => {
      mockDocker.setContainerExists(false);
      // Should not throw
      await service.removeAgent(mockDocker.docker, 'nonexistent');
    });

    it('handles already-stopped container', async () => {
      mockDocker.setContainerExists(true);
      mockDocker.setContainerRunning(false);
      // stop() will be called but that's fine — Dockerode handles it
      await service.removeAgent(mockDocker.docker, 'homeserver');
      expect(mockDocker.removedContainers).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/jared/homelab-manager && bun test src/lib/services/__tests__/agent-provisioning-service.test.ts`
Expected: FAIL — `agent-provisioning-service` module not found

- [ ] **Step 3: Implement the agent provisioning service**

Create `src/lib/services/agent-provisioning-service.ts`:

```typescript
import type Dockerode from 'dockerode';

export interface ProvisionAgentOptions {
  hostName: string;
  agentPort: number;
  agentToken: string;
  agentImage: string;
  socketProxyUrl: string;
}

export interface ProvisionAgentResult {
  containerName: string;
  agentUrl: string;
}

const CONTAINER_NAME_PREFIX = 'homelab-agent-';
const STACKS_VOLUME = 'homelab-stacks';
const STACKS_MOUNT_PATH = '/opt/homelab-manager/stacks';

/**
 * Service for provisioning and managing agent containers on Docker hosts.
 * Connects to the host's socket proxy via Dockerode to pull images,
 * create containers, and manage lifecycle.
 */
export class AgentProvisioningService {
  /**
   * Build the standard container name for a host.
   */
  getContainerName(hostName: string): string {
    return `${CONTAINER_NAME_PREFIX}${hostName}`;
  }

  /**
   * Provision an agent container on a Docker host via socket proxy.
   *
   * 1. Pull (or verify) the agent image
   * 2. Remove any existing agent container for this host
   * 3. Create and start the new agent container
   */
  async provision(
    docker: Dockerode,
    options: ProvisionAgentOptions
  ): Promise<ProvisionAgentResult> {
    const containerName = this.getContainerName(options.hostName);

    // Pull the agent image
    await this.pullImage(docker, options.agentImage);

    // Remove existing agent container if present
    await this.removeExistingContainer(docker, containerName);

    // Create the agent container
    const container = await docker.createContainer({
      name: containerName,
      Image: options.agentImage,
      Env: [
        `AGENT_TOKEN=${options.agentToken}`,
        `DOCKER_HOST=${options.socketProxyUrl}`,
        `AGENT_PORT=${options.agentPort}`,
      ],
      ExposedPorts: {
        [`${options.agentPort}/tcp`]: {},
      },
      HostConfig: {
        Binds: [`${STACKS_VOLUME}:${STACKS_MOUNT_PATH}`],
        PortBindings: {
          [`${options.agentPort}/tcp`]: [{ HostPort: String(options.agentPort) }],
        },
        RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      },
    });

    await container.start();

    // The agent URL must use the host's IP/hostname (not the container name),
    // because the container DNS name is only resolvable within the same Docker
    // network. Extract the host from the socket proxy URL.
    const proxyUrl = new URL(options.socketProxyUrl.replace(/^tcp:\/\//, 'http://'));
    const agentUrl = `http://${proxyUrl.hostname}:${options.agentPort}`;

    return { containerName, agentUrl };
  }

  /**
   * Remove an agent container from a Docker host.
   * Stops the container if running, then removes it.
   * No-op if the container does not exist.
   */
  async removeAgent(docker: Dockerode, hostName: string): Promise<void> {
    const containerName = this.getContainerName(hostName);
    await this.removeExistingContainer(docker, containerName);
  }

  private async pullImage(docker: Dockerode, image: string): Promise<void> {
    const stream = await docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async removeExistingContainer(
    docker: Dockerode,
    containerName: string
  ): Promise<void> {
    const container = docker.getContainer(containerName);
    try {
      const info = await container.inspect();
      if (info.State.Running) {
        await container.stop();
      }
      await container.remove();
    } catch (err: unknown) {
      // 404 means container doesn't exist — that's fine
      if (
        err &&
        typeof err === 'object' &&
        'statusCode' in err &&
        (err as { statusCode: number }).statusCode === 404
      ) {
        return;
      }
      throw err;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/jared/homelab-manager && bun test src/lib/services/__tests__/agent-provisioning-service.test.ts`
Expected: All tests pass

- [ ] **Step 5: Run full test suite and typecheck**

Run: `cd /home/jared/homelab-manager && bun run typecheck && bun test`
Expected: No errors, all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/lib/services/agent-provisioning-service.ts src/lib/services/__tests__/agent-provisioning-service.test.ts
git commit -m "feat(hosts): add AgentProvisioningService for deploying agent containers via socket proxy"
```

---

## Chunk 4: Agent Health Check Service

### Task 6: Health check utility

**Files:**
- Create: `src/lib/services/__tests__/agent-health-service.test.ts`
- Create: `src/lib/services/agent-health-service.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/services/__tests__/agent-health-service.test.ts`:

```typescript
import { describe, it, expect, mock } from 'bun:test';
import { checkAgentHealth, type AgentHealthResult } from '../agent-health-service';

// Use dependency injection (fetchFn parameter) instead of global fetch mock
// per CLAUDE.md rule 7: avoid globalThis mocks, use narrow-scope DI instead.

describe('agent-health-service', () => {
  describe('checkAgentHealth', () => {
    it('returns healthy result when agent responds with 200', async () => {
      const fetchFn = mock(async () =>
        new Response(
          JSON.stringify({
            status: 'ok',
            version: '0.1.0',
            dockerVersion: '24.0.7',
            uptime: 3600,
          }),
          { status: 200 }
        )
      ) as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn);

      expect(result.healthy).toBe(true);
      expect(result.version).toBe('0.1.0');
      expect(result.dockerVersion).toBe('24.0.7');
      expect(result.error).toBeUndefined();
    });

    it('returns unhealthy result when agent responds with non-200', async () => {
      const fetchFn = mock(async () =>
        new Response('Internal Server Error', { status: 500 })
      ) as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn);

      expect(result.healthy).toBe(false);
      expect(result.error).toContain('500');
    });

    it('returns unhealthy result when fetch throws (network error)', async () => {
      const fetchFn = mock(async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn);

      expect(result.healthy).toBe(false);
      expect(result.error).toContain('ECONNREFUSED');
    });

    it('calls the correct URL with /health path', async () => {
      let calledUrl = '';
      const fetchFn = mock(async (input: string | URL | Request) => {
        calledUrl = typeof input === 'string' ? input : input.toString();
        return new Response(
          JSON.stringify({ status: 'ok', version: '0.1.0' }),
          { status: 200 }
        );
      }) as typeof fetch;

      await checkAgentHealth('http://agent:9090', undefined, fetchFn);
      expect(calledUrl).toBe('http://agent:9090/health');
    });

    it('uses a timeout via AbortSignal', async () => {
      const fetchFn = mock(async (_input: string | URL | Request, init?: RequestInit) => {
        expect(init?.signal).toBeDefined();
        return new Response(
          JSON.stringify({ status: 'ok', version: '0.1.0' }),
          { status: 200 }
        );
      }) as typeof fetch;

      await checkAgentHealth('http://agent:9090', undefined, fetchFn);
    });

    it('returns unhealthy on timeout (AbortError)', async () => {
      const fetchFn = mock(async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }) as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090', undefined, fetchFn);

      expect(result.healthy).toBe(false);
      expect(result.error).toContain('timed out');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/jared/homelab-manager && bun test src/lib/services/__tests__/agent-health-service.test.ts`
Expected: FAIL — `agent-health-service` module not found

- [ ] **Step 3: Implement the health check service**

Create `src/lib/services/agent-health-service.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/jared/homelab-manager && bun test src/lib/services/__tests__/agent-health-service.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/agent-health-service.ts src/lib/services/__tests__/agent-health-service.test.ts
git commit -m "feat(hosts): add agent health check service with timeout support"
```

---

## Chunk 5: Agent Update Service

### Task 7: Agent update via socket proxy bypass

**Files:**
- Create: `src/lib/services/__tests__/agent-update-service.test.ts`
- Create: `src/lib/services/agent-update-service.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/services/__tests__/agent-update-service.test.ts`:

```typescript
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { AgentUpdateService } from '../agent-update-service';

function createMockDockerode() {
  const pulledImages: string[] = [];
  const stoppedContainers: string[] = [];
  const removedContainers: string[] = [];
  const createdContainers: { name: string; config: Record<string, unknown> }[] = [];
  const startedContainers: string[] = [];

  const mockContainer = {
    inspect: async () => ({
      State: { Running: true },
      Config: {
        Image: 'ghcr.io/org/homelab-manager-agent:latest',
        Env: [
          'AGENT_TOKEN=existing-token',
          'DOCKER_HOST=tcp://192.168.1.10:2375',
          'AGENT_PORT=9090',
        ],
      },
      HostConfig: {
        Binds: ['homelab-stacks:/opt/homelab-manager/stacks'],
        PortBindings: { '9090/tcp': [{ HostPort: '9090' }] },
        RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      },
      Name: '/homelab-agent-homeserver',
    }),
    stop: async () => {
      stoppedContainers.push('homelab-agent-homeserver');
    },
    remove: async () => {
      removedContainers.push('homelab-agent-homeserver');
    },
    start: async () => {
      startedContainers.push('homelab-agent-homeserver');
    },
  };

  const docker = {
    pull: async (image: string) => {
      pulledImages.push(image);
      return {};
    },
    getContainer: (_name: string) => mockContainer,
    createContainer: async (config: Record<string, unknown>) => {
      createdContainers.push({ name: config.name as string, config });
      return mockContainer;
    },
    modem: {
      followProgress: (_stream: any, callback: (err: Error | null, output: unknown[]) => void) => {
        callback(null, []);
      },
    },
  } as any;

  return {
    docker,
    pulledImages,
    stoppedContainers,
    removedContainers,
    createdContainers,
    startedContainers,
  };
}

describe('AgentUpdateService', () => {
  let service: AgentUpdateService;
  let mockDocker: ReturnType<typeof createMockDockerode>;

  beforeEach(() => {
    service = new AgentUpdateService();
    mockDocker = createMockDockerode();
  });

  // Use dependency injection (fetchFn) instead of global fetch mock
  const mockFetchFn = mock(async () =>
    new Response(JSON.stringify({ status: 'ok', version: '0.2.0' }), { status: 200 })
  ) as typeof fetch;

  describe('updateAgent', () => {
    it('pulls the new image via socket proxy', async () => {
      await service.updateAgent(mockDocker.docker, 'homeserver', 'ghcr.io/org/homelab-manager-agent:latest', mockFetchFn);

      expect(mockDocker.pulledImages).toContain('ghcr.io/org/homelab-manager-agent:latest');
    });

    it('stops and removes the old container', async () => {
      await service.updateAgent(mockDocker.docker, 'homeserver', 'ghcr.io/org/homelab-manager-agent:latest', mockFetchFn);

      expect(mockDocker.stoppedContainers).toHaveLength(1);
      expect(mockDocker.removedContainers).toHaveLength(1);
    });

    it('creates a new container with the same config', async () => {
      await service.updateAgent(mockDocker.docker, 'homeserver', 'ghcr.io/org/homelab-manager-agent:latest', mockFetchFn);

      expect(mockDocker.createdContainers).toHaveLength(1);
      expect(mockDocker.createdContainers[0].name).toBe('homelab-agent-homeserver');
    });

    it('starts the new container', async () => {
      await service.updateAgent(mockDocker.docker, 'homeserver', 'ghcr.io/org/homelab-manager-agent:latest', mockFetchFn);

      expect(mockDocker.startedContainers).toHaveLength(1);
    });

    it('preserves env vars from the old container', async () => {
      await service.updateAgent(mockDocker.docker, 'homeserver', 'ghcr.io/org/homelab-manager-agent:latest', mockFetchFn);

      const config = mockDocker.createdContainers[0].config;
      const env = config.Env as string[];
      expect(env).toContainEqual('AGENT_TOKEN=existing-token');
      expect(env).toContainEqual('DOCKER_HOST=tcp://192.168.1.10:2375');
    });

    it('returns the new version from health check', async () => {
      const result = await service.updateAgent(
        mockDocker.docker,
        'homeserver',
        'ghcr.io/org/homelab-manager-agent:latest',
        mockFetchFn
      );

      expect(result.version).toBe('0.2.0');
      expect(result.healthy).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/jared/homelab-manager && bun test src/lib/services/__tests__/agent-update-service.test.ts`
Expected: FAIL — `agent-update-service` module not found

- [ ] **Step 3: Implement the agent update service**

Create `src/lib/services/agent-update-service.ts`:

```typescript
import type Dockerode from 'dockerode';
import { checkAgentHealth, type AgentHealthResult } from './agent-health-service';

const CONTAINER_NAME_PREFIX = 'homelab-agent-';
const HEALTH_CHECK_RETRY_DELAYS_MS = [500, 1000, 2000]; // Exponential backoff
const POST_UPDATE_HEALTH_CHECK_TIMEOUT_MS = 10000;

export interface AgentUpdateResult extends AgentHealthResult {
  containerName: string;
}

/**
 * Service for updating agent containers via socket proxy bypass.
 *
 * The update bypasses the agent itself (which can't replace its own container)
 * by connecting directly to the host's socket proxy URL via Dockerode.
 *
 * Sequence: pull new image -> inspect old container -> stop old -> remove old
 *           -> create new with same config -> start new -> verify health
 */
export class AgentUpdateService {
  /**
   * Update an agent container to a new image version.
   *
   * @param docker - Dockerode instance connected to the host's socket proxy
   * @param hostName - Logical host name (used to derive container name)
   * @param newImage - New agent image to pull and deploy
   * @returns Health check result after update
   */
  async updateAgent(
    docker: Dockerode,
    hostName: string,
    newImage: string,
    fetchFn: typeof fetch = globalThis.fetch
  ): Promise<AgentUpdateResult> {
    const containerName = `${CONTAINER_NAME_PREFIX}${hostName}`;

    // 1. Pull the new image
    await this.pullImage(docker, newImage);

    // 2. Inspect the existing container to capture its config
    const existingContainer = docker.getContainer(containerName);
    const inspectData = await existingContainer.inspect();

    const oldEnv = inspectData.Config.Env || [];
    const oldHostConfig = inspectData.HostConfig;

    // 3. Stop and remove the old container
    if (inspectData.State.Running) {
      await existingContainer.stop();
    }
    await existingContainer.remove();

    // 4. Create the new container with the same config but new image
    const newContainer = await docker.createContainer({
      name: containerName,
      Image: newImage,
      Env: oldEnv,
      ExposedPorts: inspectData.Config.ExposedPorts,
      HostConfig: {
        Binds: oldHostConfig.Binds,
        PortBindings: oldHostConfig.PortBindings,
        RestartPolicy: oldHostConfig.RestartPolicy,
      },
    });

    // 5. Start the new container
    await newContainer.start();

    // 6. Verify health with exponential backoff retry (matches BaseCollector pattern)
    const agentPort = this.extractAgentPort(oldHostConfig.PortBindings);
    const dockerHost = this.extractHostFromEnv(oldEnv);
    const agentUrl = `http://${dockerHost}:${agentPort}`;

    let healthResult: Awaited<ReturnType<typeof checkAgentHealth>> = {
      healthy: false,
      error: 'Health check not attempted',
    };

    for (const delayMs of HEALTH_CHECK_RETRY_DELAYS_MS) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      healthResult = await checkAgentHealth(agentUrl, POST_UPDATE_HEALTH_CHECK_TIMEOUT_MS, fetchFn);
      if (healthResult.healthy) break;
    }

    return {
      ...healthResult,
      containerName,
    };
  }

  private async pullImage(docker: Dockerode, image: string): Promise<void> {
    const stream = await docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private extractAgentPort(portBindings: Record<string, { HostPort: string }[]>): number {
    // Get the first port binding
    const keys = Object.keys(portBindings);
    if (keys.length === 0) return 9090;
    const binding = portBindings[keys[0]];
    if (!binding || binding.length === 0) return 9090;
    return Number(binding[0].HostPort) || 9090;
  }

  private extractHostFromEnv(env: string[]): string {
    // Extract hostname from DOCKER_HOST env var (e.g., "tcp://192.168.1.10:2375")
    const dockerHostEntry = env.find((e) => e.startsWith('DOCKER_HOST='));
    if (!dockerHostEntry) return 'localhost';
    const dockerHostUrl = dockerHostEntry.split('=')[1];
    try {
      const parsed = new URL(dockerHostUrl.replace(/^tcp:\/\//, 'http://'));
      return parsed.hostname;
    } catch {
      return 'localhost';
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/jared/homelab-manager && bun test src/lib/services/__tests__/agent-update-service.test.ts`
Expected: All tests pass

- [ ] **Step 5: Run full test suite and typecheck**

Run: `cd /home/jared/homelab-manager && bun run typecheck && bun test`
Expected: No errors, all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/lib/services/agent-update-service.ts src/lib/services/__tests__/agent-update-service.test.ts
git commit -m "feat(hosts): add AgentUpdateService for updating agents via socket proxy bypass"
```

---

## Chunk 6: Host Management Server Functions

### Task 8: Host management server functions

**Files:**
- Create: `src/data/__tests__/hosts.functions.test.ts`
- Create: `src/data/hosts.functions.tsx`

- [ ] **Step 1: Write the failing tests**

Create `src/data/__tests__/hosts.functions.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

/**
 * Server function tests for host management.
 *
 * These test exports, input validation schemas, and feature flag gating.
 * Full integration tests require a running database and are covered by
 * the E2E test suite.
 */
describe('hosts.functions module', () => {
  const originalEnv = process.env.DOCKER_MANAGEMENT_FEATURE_FLAG;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DOCKER_MANAGEMENT_FEATURE_FLAG;
    } else {
      process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = originalEnv;
    }
  });

  describe('exports', () => {
    it('exports addHost server function', async () => {
      const mod = await import('../hosts.functions');
      expect(mod.addHost).toBeDefined();
      expect(typeof mod.addHost).toBe('function');
    });

    it('exports removeHost server function', async () => {
      const mod = await import('../hosts.functions');
      expect(mod.removeHost).toBeDefined();
      expect(typeof mod.removeHost).toBe('function');
    });

    it('exports listHosts server function', async () => {
      const mod = await import('../hosts.functions');
      expect(mod.listHosts).toBeDefined();
      expect(typeof mod.listHosts).toBe('function');
    });

    it('exports updateAgent server function', async () => {
      const mod = await import('../hosts.functions');
      expect(mod.updateAgent).toBeDefined();
      expect(typeof mod.updateAgent).toBe('function');
    });

    it('exports checkHostHealth server function', async () => {
      const mod = await import('../hosts.functions');
      expect(mod.checkHostHealth).toBeDefined();
      expect(typeof mod.checkHostHealth).toBe('function');
    });
  });

  describe('feature flag gating', () => {
    it('addHost throws when feature flag is off', async () => {
      delete process.env.DOCKER_MANAGEMENT_FEATURE_FLAG;
      const mod = await import('../hosts.functions');
      await expect(
        mod.addHost({ data: { name: 'test', socketProxyUrl: 'tcp://192.168.1.10:2375' } })
      ).rejects.toThrow('Docker management feature is not enabled');
    });

    it('removeHost throws when feature flag is off', async () => {
      delete process.env.DOCKER_MANAGEMENT_FEATURE_FLAG;
      const mod = await import('../hosts.functions');
      await expect(
        mod.removeHost({ data: { hostId: 1 } })
      ).rejects.toThrow('Docker management feature is not enabled');
    });

    it('checkHostHealth throws when feature flag is off', async () => {
      delete process.env.DOCKER_MANAGEMENT_FEATURE_FLAG;
      const mod = await import('../hosts.functions');
      await expect(
        mod.checkHostHealth({ data: { hostId: 1 } })
      ).rejects.toThrow('Docker management feature is not enabled');
    });

    it('listHosts throws when feature flag is off', async () => {
      delete process.env.DOCKER_MANAGEMENT_FEATURE_FLAG;
      const mod = await import('../hosts.functions');
      await expect(
        mod.listHosts({})
      ).rejects.toThrow('Docker management feature is not enabled');
    });
  });

  describe('input validation', () => {
    it('addHost rejects empty name', async () => {
      process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'true';
      const mod = await import('../hosts.functions');
      await expect(
        mod.addHost({ data: { name: '', socketProxyUrl: 'tcp://192.168.1.10:2375' } })
      ).rejects.toThrow();
    });

    it('addHost rejects invalid socketProxyUrl scheme', async () => {
      process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'true';
      const mod = await import('../hosts.functions');
      await expect(
        mod.addHost({ data: { name: 'test', socketProxyUrl: 'ftp://192.168.1.10:2375' } })
      ).rejects.toThrow();
    });

    it('addHost accepts tcp:// socketProxyUrl', async () => {
      process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'true';
      const mod = await import('../hosts.functions');
      // Will fail at Dockerode connection, not at validation
      await expect(
        mod.addHost({ data: { name: 'test', socketProxyUrl: 'tcp://192.168.1.10:2375' } })
      ).rejects.not.toThrow(/scheme/);
    });

    it('removeHost rejects non-positive hostId', async () => {
      process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'true';
      const mod = await import('../hosts.functions');
      await expect(
        mod.removeHost({ data: { hostId: 0 } })
      ).rejects.toThrow();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/jared/homelab-manager && bun test src/data/__tests__/hosts.functions.test.ts`
Expected: FAIL — `hosts.functions` module not found

- [ ] **Step 3: Implement the server functions**

Create `src/data/hosts.functions.tsx`:

```typescript
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';

// ----- Schemas -----

// Custom validator for socket proxy URLs — Zod's .url() only accepts http/https
// but Docker socket proxies use tcp:// scheme
const socketProxyUrlSchema = z.string().min(1).refine(
  (val) => /^(tcp|http|https):\/\/.+/.test(val),
  { message: 'Must be a valid URL with tcp://, http://, or https:// scheme' }
);

const addHostSchema = z.object({
  name: z.string().min(1).max(100),
  socketProxyUrl: socketProxyUrlSchema,
  agentPort: z.number().int().min(1).max(65535).optional().default(9090),
});

const removeHostSchema = z.object({
  hostId: z.number().int().positive(),
});

const updateAgentSchema = z.object({
  hostId: z.number().int().positive(),
});

const checkHostHealthSchema = z.object({
  hostId: z.number().int().positive(),
});

// ----- Types -----

export interface HostListItem {
  id: number;
  name: string;
  agentUrl: string;
  socketProxyUrl: string;
  agentVersion: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface AddHostResult {
  host: HostListItem;
  healthy: boolean;
  error?: string;
}

export interface HealthCheckResult {
  hostId: number;
  healthy: boolean;
  version?: string;
  dockerVersion?: string;
  error?: string;
}

export interface UpdateAgentResult {
  hostId: number;
  healthy: boolean;
  version?: string;
  error?: string;
}

// ----- Constants -----

const AGENT_IMAGE_PROD = 'ghcr.io/homelab-manager/agent:latest';
const AGENT_IMAGE_DEV = 'homelab-manager-agent:dev';

function getAgentImage(): string {
  return process.env.NODE_ENV === 'development' ? AGENT_IMAGE_DEV : AGENT_IMAGE_PROD;
}

// ----- Server Functions -----

// NOTE: Per CLAUDE.md rule 3, all server logic should use createServerFn() + middleware
// injection. When the codebase establishes a middleware pattern (e.g., for auth or
// database connection injection), these server functions should be updated to use
// .middleware([authMiddleware, dbMiddleware]) instead of manually importing and
// constructing dependencies inside each handler.

/**
 * Add a new managed host: connect to socket proxy, provision agent, store in DB.
 *
 * Flow:
 * 1. Validate feature flag is enabled
 * 2. Connect to socket proxy via Dockerode
 * 3. Generate token, hash it
 * 4. Provision agent container
 * 5. Store host record in managed_hosts
 * 6. Verify agent health
 * 7. Rollback on failure, or update status to 'online'
 */
export const addHost = createServerFn()
  .inputValidator(addHostSchema)
  .handler(async ({ data }): Promise<AddHostResult> => {
    const { isDockerManagementEnabled } = await import(
      '@/lib/config/feature-flags'
    );
    if (!isDockerManagementEnabled()) {
      throw new Error('Docker management feature is not enabled');
    }

    const Dockerode = (await import('dockerode')).default;
    const { generateToken, hashToken } = await import(
      '@/lib/services/token-service'
    );
    const { AgentProvisioningService } = await import(
      '@/lib/services/agent-provisioning-service'
    );
    const { checkAgentHealth } = await import(
      '@/lib/services/agent-health-service'
    );
    const { databaseConnectionManager } = await import(
      '@/lib/clients/database-client'
    );
    const { loadDatabaseConfig } = await import(
      '@/lib/config/database-config'
    );
    const { HostRepository } = await import(
      '@/lib/database/repositories/host-repository'
    );

    // Parse socket proxy URL for Dockerode connection
    const proxyUrl = new URL(data.socketProxyUrl);
    const docker = new Dockerode({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port) || 2375,
      protocol: (proxyUrl.protocol.replace(':', '') as 'http' | 'https') || 'http',
    });

    // Generate and hash token
    const plainToken = generateToken();
    const tokenHash = await hashToken(plainToken);

    // Provision agent container
    const provisioningService = new AgentProvisioningService();
    const provisionResult = await provisioningService.provision(docker, {
      hostName: data.name,
      agentPort: data.agentPort,
      agentToken: plainToken,
      agentImage: getAgentImage(),
      socketProxyUrl: data.socketProxyUrl,
    });

    // Store host in database
    const dbConfig = loadDatabaseConfig();
    const dbClient = await databaseConnectionManager.getClient(dbConfig);
    const repo = new HostRepository(dbClient.getPool());

    const host = await repo.create({
      name: data.name,
      agent_url: provisionResult.agentUrl,
      agent_token_hash: tokenHash,
      socket_proxy_url: data.socketProxyUrl,
    });

    // Health check with exponential backoff retry (matches BaseCollector pattern)
    const healthRetryDelays = [500, 1000, 2000];
    let healthResult = { healthy: false, version: undefined as string | undefined, error: 'Health check not attempted' };
    for (const delayMs of healthRetryDelays) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      healthResult = await checkAgentHealth(provisionResult.agentUrl);
      if (healthResult.healthy) break;
    }

    // If health check failed after all retries, rollback: remove container and DB record
    if (!healthResult.healthy) {
      try {
        const provisioningServiceCleanup = new AgentProvisioningService();
        await provisioningServiceCleanup.removeAgent(docker, data.name);
      } catch {
        // Best-effort cleanup
      }
      await repo.delete(host.id);
      throw new Error(
        `Agent provisioned but health check failed after ${healthRetryDelays.length} retries: ${healthResult.error}. Host record and container have been cleaned up.`
      );
    }

    const status = 'online';
    await repo.updateStatus(host.id, status);

    if (healthResult.version) {
      await repo.updateAgentVersion(host.id, healthResult.version);
    }

    return {
      host: {
        id: host.id,
        name: host.name,
        agentUrl: host.agent_url,
        socketProxyUrl: host.socket_proxy_url,
        agentVersion: healthResult.version || null,
        status,
        createdAt: host.created_at.toISOString(),
        updatedAt: host.updated_at.toISOString(),
      },
      healthy: healthResult.healthy,
      error: healthResult.error,
    };
  });

/**
 * Remove a managed host: stop + remove agent container, delete DB record.
 */
export const removeHost = createServerFn()
  .inputValidator(removeHostSchema)
  .handler(async ({ data }): Promise<{ success: boolean }> => {
    const { isDockerManagementEnabled } = await import(
      '@/lib/config/feature-flags'
    );
    if (!isDockerManagementEnabled()) {
      throw new Error('Docker management feature is not enabled');
    }

    const Dockerode = (await import('dockerode')).default;
    const { AgentProvisioningService } = await import(
      '@/lib/services/agent-provisioning-service'
    );
    const { databaseConnectionManager } = await import(
      '@/lib/clients/database-client'
    );
    const { loadDatabaseConfig } = await import(
      '@/lib/config/database-config'
    );
    const { HostRepository } = await import(
      '@/lib/database/repositories/host-repository'
    );

    const dbConfig = loadDatabaseConfig();
    const dbClient = await databaseConnectionManager.getClient(dbConfig);
    const repo = new HostRepository(dbClient.getPool());

    const host = await repo.findById(data.hostId);
    if (!host) {
      throw new Error(`Host with id ${data.hostId} not found`);
    }

    // Connect to socket proxy and remove agent container
    try {
      const proxyUrl = new URL(host.socket_proxy_url);
      const docker = new Dockerode({
        host: proxyUrl.hostname,
        port: Number(proxyUrl.port) || 2375,
        protocol: (proxyUrl.protocol.replace(':', '') as 'http' | 'https') || 'http',
      });

      const provisioningService = new AgentProvisioningService();
      await provisioningService.removeAgent(docker, host.name);
    } catch (err) {
      // Log but don't fail — the host record should still be removed
      // even if the container can't be reached
      console.error(
        `[removeHost] Failed to remove agent container for ${host.name}:`,
        err instanceof Error ? err.message : err
      );
    }

    // Delete from database
    await repo.delete(data.hostId);

    return { success: true };
  });

/**
 * List all managed hosts with their current status.
 * Throws when the feature flag is off, consistent with all other host
 * management functions. The UI should check isDockerManagementEnabled()
 * on the client side before calling this function to avoid showing
 * errors in navigation/sidebar.
 */
export const listHosts = createServerFn()
  .handler(async (): Promise<HostListItem[]> => {
    const { isDockerManagementEnabled } = await import(
      '@/lib/config/feature-flags'
    );
    if (!isDockerManagementEnabled()) {
      throw new Error('Docker management feature is not enabled');
    }

    const { databaseConnectionManager } = await import(
      '@/lib/clients/database-client'
    );
    const { loadDatabaseConfig } = await import(
      '@/lib/config/database-config'
    );
    const { HostRepository } = await import(
      '@/lib/database/repositories/host-repository'
    );

    const dbConfig = loadDatabaseConfig();
    const dbClient = await databaseConnectionManager.getClient(dbConfig);
    const repo = new HostRepository(dbClient.getPool());

    const hosts = await repo.findAll();

    return hosts.map((h) => ({
      id: h.id,
      name: h.name,
      agentUrl: h.agent_url,
      socketProxyUrl: h.socket_proxy_url,
      agentVersion: h.agent_version,
      status: h.status,
      createdAt: h.created_at.toISOString(),
      updatedAt: h.updated_at.toISOString(),
    }));
  });

/**
 * Update an agent to the latest image version.
 * Bypasses the agent by connecting directly to the socket proxy.
 */
export const updateAgent = createServerFn()
  .inputValidator(updateAgentSchema)
  .handler(async ({ data }): Promise<UpdateAgentResult> => {
    const { isDockerManagementEnabled } = await import(
      '@/lib/config/feature-flags'
    );
    if (!isDockerManagementEnabled()) {
      throw new Error('Docker management feature is not enabled');
    }

    const Dockerode = (await import('dockerode')).default;
    const { AgentUpdateService } = await import(
      '@/lib/services/agent-update-service'
    );
    const { databaseConnectionManager } = await import(
      '@/lib/clients/database-client'
    );
    const { loadDatabaseConfig } = await import(
      '@/lib/config/database-config'
    );
    const { HostRepository } = await import(
      '@/lib/database/repositories/host-repository'
    );

    const dbConfig = loadDatabaseConfig();
    const dbClient = await databaseConnectionManager.getClient(dbConfig);
    const repo = new HostRepository(dbClient.getPool());

    const host = await repo.findById(data.hostId);
    if (!host) {
      throw new Error(`Host with id ${data.hostId} not found`);
    }

    // Connect directly to socket proxy (bypassing agent)
    const proxyUrl = new URL(host.socket_proxy_url);
    const docker = new Dockerode({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port) || 2375,
      protocol: (proxyUrl.protocol.replace(':', '') as 'http' | 'https') || 'http',
    });

    const updateService = new AgentUpdateService();
    const result = await updateService.updateAgent(docker, host.name, getAgentImage());

    // Update database
    if (result.healthy) {
      await repo.updateStatus(host.id, 'online');
      if (result.version) {
        await repo.updateAgentVersion(host.id, result.version);
      }
    } else {
      await repo.updateStatus(host.id, 'degraded');
    }

    return {
      hostId: host.id,
      healthy: result.healthy,
      version: result.version,
      error: result.error,
    };
  });

/**
 * Check the health of a specific host's agent.
 * Called on-demand from the UI, not continuous.
 */
export const checkHostHealth = createServerFn()
  .inputValidator(checkHostHealthSchema)
  .handler(async ({ data }): Promise<HealthCheckResult> => {
    const { isDockerManagementEnabled } = await import(
      '@/lib/config/feature-flags'
    );
    if (!isDockerManagementEnabled()) {
      throw new Error('Docker management feature is not enabled');
    }

    const { checkAgentHealth } = await import(
      '@/lib/services/agent-health-service'
    );
    const { databaseConnectionManager } = await import(
      '@/lib/clients/database-client'
    );
    const { loadDatabaseConfig } = await import(
      '@/lib/config/database-config'
    );
    const { HostRepository } = await import(
      '@/lib/database/repositories/host-repository'
    );

    const dbConfig = loadDatabaseConfig();
    const dbClient = await databaseConnectionManager.getClient(dbConfig);
    const repo = new HostRepository(dbClient.getPool());

    const host = await repo.findById(data.hostId);
    if (!host) {
      throw new Error(`Host with id ${data.hostId} not found`);
    }

    const healthResult = await checkAgentHealth(host.agent_url);

    // Update status in database
    const newStatus = healthResult.healthy ? 'online' : 'offline';
    await repo.updateStatus(host.id, newStatus);

    if (healthResult.version) {
      await repo.updateAgentVersion(host.id, healthResult.version);
    }

    return {
      hostId: host.id,
      healthy: healthResult.healthy,
      version: healthResult.version,
      dockerVersion: healthResult.dockerVersion,
      error: healthResult.error,
    };
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/jared/homelab-manager && bun test src/data/__tests__/hosts.functions.test.ts`
Expected: All tests pass

- [ ] **Step 5: Run full test suite and typecheck**

Run: `cd /home/jared/homelab-manager && bun run typecheck && bun test`
Expected: No errors, all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/data/hosts.functions.tsx src/data/__tests__/hosts.functions.test.ts
git commit -m "feat(hosts): add server functions for host CRUD, health check, and agent update"
```

---

## Chunk 7: Mock Functions for Demo Mode & Migration Path

### Task 9: Mock host functions for demo mode

**Files:**
- Create: `src/lib/mock/functions/hosts.functions.ts`

- [ ] **Step 1: Create mock host functions**

Create `src/lib/mock/functions/hosts.functions.ts`:

```typescript
import type {
  HostListItem,
  AddHostResult,
  HealthCheckResult,
  UpdateAgentResult,
} from '@/data/hosts.functions';

const mockHosts: HostListItem[] = [
  {
    id: 1,
    name: 'homeserver',
    agentUrl: 'http://192.168.1.10:9090',
    socketProxyUrl: 'tcp://192.168.1.10:2375',
    agentVersion: '0.1.0',
    status: 'online',
    createdAt: '2026-01-15T10:00:00Z',
    updatedAt: '2026-01-15T10:00:00Z',
  },
  {
    id: 2,
    name: 'media-server',
    agentUrl: 'http://192.168.1.20:9090',
    socketProxyUrl: 'tcp://192.168.1.20:2375',
    agentVersion: '0.1.0',
    status: 'online',
    createdAt: '2026-02-01T14:30:00Z',
    updatedAt: '2026-02-01T14:30:00Z',
  },
];

export async function addHost(_data: {
  name: string;
  socketProxyUrl: string;
  agentPort?: number;
}): Promise<AddHostResult> {
  const now = new Date().toISOString();
  const newHost: HostListItem = {
    id: mockHosts.length + 1,
    name: _data.name,
    agentUrl: `http://mock-host:${_data.agentPort ?? 9090}`,
    socketProxyUrl: _data.socketProxyUrl,
    agentVersion: '0.1.0',
    status: 'online',
    createdAt: now,
    updatedAt: now,
  };
  return { host: newHost, healthy: true };
}

export async function removeHost(_data: {
  hostId: number;
}): Promise<{ success: boolean }> {
  return { success: true };
}

export async function listHosts(): Promise<HostListItem[]> {
  return mockHosts;
}

export async function updateAgent(_data: {
  hostId: number;
}): Promise<UpdateAgentResult> {
  return {
    hostId: _data.hostId,
    healthy: true,
    version: '0.2.0',
  };
}

export async function checkHostHealth(_data: {
  hostId: number;
}): Promise<HealthCheckResult> {
  return {
    hostId: _data.hostId,
    healthy: true,
    version: '0.1.0',
    dockerVersion: '24.0.7',
  };
}
```

- [ ] **Step 2: Run full test suite and typecheck**

Run: `cd /home/jared/homelab-manager && bun run typecheck && bun test`
Expected: No errors, all tests pass

- [ ] **Step 3: Commit**

```bash
git add src/lib/mock/functions/hosts.functions.ts
git commit -m "feat(hosts): add mock host functions for demo mode"
```

---

### Task 10: Document migration path for DOCKER_HOST_N env vars

**Files:**
- Modify: `src/lib/config/docker-config.ts` (add comment documenting coexistence)

- [ ] **Step 1: Add migration path documentation comment**

Add a JSDoc comment at the top of `src/lib/config/docker-config.ts` explaining the coexistence of env-var-based hosts and database-managed hosts:

```typescript
/**
 * Docker host configuration from environment variables.
 *
 * Migration path: When DOCKER_MANAGEMENT_FEATURE_FLAG is OFF (default),
 * these env-var-based hosts are the sole source of Docker host configuration
 * and provide monitoring-only access via direct socket proxy connections.
 *
 * When DOCKER_MANAGEMENT_FEATURE_FLAG is ON, new hosts are added via the UI
 * and stored in the `managed_hosts` database table. Env-var hosts continue
 * to work for monitoring but are NOT managed by the agent bootstrap system.
 * The two systems coexist: env-var hosts for legacy/monitoring, managed hosts
 * for full stack management with agents.
 */
```

- [ ] **Step 2: Run typecheck**

Run: `cd /home/jared/homelab-manager && bun run typecheck`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/config/docker-config.ts
git commit -m "docs(config): document DOCKER_HOST_N migration path with managed hosts"
```

---

## Chunk 8: Agent Stats Collection from Managed Hosts

This chunk replaces direct Dockerode stats collection with SSE-based collection from agent containers running on managed hosts. The `AgentStatsCollector` connects to each managed host's agent `GET /stats/stream` endpoint, parses SSE events into `DockerStatsRow` rows, and inserts them via the existing `StatsRepository.insertDockerStats()`. Legacy `DOCKER_HOST_N` env var hosts continue using `DockerCollector` unchanged.

**Design note — agent token access:** The existing `managed_hosts` table stores only a bcrypt hash (`agent_token_hash`). The worker needs the plaintext token to authenticate to agents via `Authorization: Bearer <token>`. Since the socket proxy URL is already stored in plaintext (providing equivalent access), storing the plaintext token is acceptable. Task 11 adds an `agent_token` column via migration. The provisioning server function (Task 8, Chunk 6) must be updated to also store the plaintext token when creating a host — that change is noted but deferred to a follow-up since it touches code outside this chunk's scope.

**SSE data shape from agent** (emitted by `agent/src/routes/stats.ts`):
```json
{
  "containerId": "abc123...",
  "containerName": "plex",
  "image": "plexinc/plex-media-server:latest",
  "cpuPercent": 12.5,
  "memoryUsage": 536870912,
  "memoryLimit": 8589934592,
  "memoryPercent": 6.25,
  "networkRxBytesPerSec": 1024,
  "networkTxBytesPerSec": 512,
  "blockReadBytesPerSec": 2048,
  "blockWriteBytesPerSec": 1024,
  "timestamp": "2026-03-13T12:00:00.000Z"
}
```

Note: The agent emits pre-computed rates — no `DockerRateCalculator` needed on this side. Field name mapping is required: agent uses `blockReadBytesPerSec`/`blockWriteBytesPerSec` while the DB column uses `block_io_read_bytes_per_sec`/`block_io_write_bytes_per_sec`.

### Task 11: Migration to add agent_token column

**Files:**
- Create: `migrations/010_managed_hosts_agent_token.sql`

- [ ] **Step 1: Create `migrations/010_managed_hosts_agent_token.sql`**

```sql
-- Add plaintext agent token column for worker authentication to agent SSE endpoints.
-- The worker needs the token to send Authorization: Bearer <token> headers.
-- Security note: the socket_proxy_url column already provides equivalent access,
-- so storing the plaintext token does not meaningfully increase attack surface.
ALTER TABLE managed_hosts ADD COLUMN IF NOT EXISTS agent_token TEXT;
```

- [ ] **Step 2: Verify migration SQL syntax**

Run: `cd /home/jared/homelab-manager && cat migrations/010_managed_hosts_agent_token.sql`
Expected: Valid SQL with no syntax errors

- [ ] **Step 3: Update HostRepository types and queries**

In `src/lib/database/repositories/host-repository.ts`, add `agent_token` to `ManagedHost` interface and `CreateHostInput`:

```typescript
export interface ManagedHost {
  id: number;
  name: string;
  agent_url: string;
  agent_token_hash: string;
  agent_token: string | null; // plaintext token for worker auth
  socket_proxy_url: string;
  agent_version: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreateHostInput {
  name: string;
  agent_url: string;
  agent_token_hash: string;
  agent_token: string; // plaintext token stored for worker use
  socket_proxy_url: string;
}
```

Update `rowToHost` to include `agent_token: row.agent_token`. Update `create()` INSERT to include the `agent_token` column.

- [ ] **Step 4: Run typecheck and tests**

Run: `cd /home/jared/homelab-manager && bun run typecheck && bun test`
Expected: No errors, all tests pass (update existing host-repository tests to include `agent_token` field)

- [ ] **Step 5: Commit**

```bash
git add migrations/010_managed_hosts_agent_token.sql src/lib/database/repositories/host-repository.ts src/lib/database/repositories/__tests__/host-repository.test.ts
git commit -m "feat(db): add agent_token column to managed_hosts for worker authentication"
```

### Task 12: AgentStatsCollector

**Files:**
- Create: `src/worker/collectors/__tests__/agent-stats-collector.test.ts`
- Create: `src/worker/collectors/agent-stats-collector.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/worker/collectors/__tests__/agent-stats-collector.test.ts`:

```typescript
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { AgentStatsCollector } from '../agent-stats-collector';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';
import type { DockerStatsRow } from '@/types/docker';

/** Create a mock DatabaseClient that captures insertDockerStats calls */
function createMockDb() {
  const insertedRows: DockerStatsRow[][] = [];
  const upsertedMetadata: { source: string; entity: string; key: string; value: string }[] = [];
  return {
    db: {
      getPool: () => ({
        query: async () => ({ rows: [], rowCount: 0 }),
      }),
    } as any,
    insertedRows,
    upsertedMetadata,
    /** Patch the repository after construction */
    patchRepository(collector: AgentStatsCollector) {
      // Access the protected repository via any cast
      const repo = (collector as any).repository;
      repo.insertDockerStats = async (rows: DockerStatsRow[]) => {
        insertedRows.push(rows);
      };
      repo.upsertEntityMetadata = async (source: string, entity: string, key: string, value: string) => {
        upsertedMetadata.push({ source, entity, key, value });
      };
    },
  };
}

const defaultConfig = {
  enabled: true,
  docker: { enabled: true },
  zfs: { enabled: false },
  proxmox: { enabled: false },
  collection: { interval: 1000 },
} as any;

const sampleHost: ManagedHost = {
  id: 1,
  name: 'homeserver',
  agent_url: 'http://192.168.1.10:9090',
  agent_token_hash: '$2b$10$hashedtoken',
  agent_token: 'test-token-uuid',
  socket_proxy_url: 'tcp://192.168.1.10:2375',
  agent_version: '0.1.0',
  status: 'online',
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
};

/** Build a ReadableStream that emits SSE-formatted lines, then closes */
function createMockSSEStream(events: Record<string, unknown>[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
}

/** Build a ReadableStream that emits events then errors */
function createErrorSSEStream(events: Record<string, unknown>[], error: Error): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.error(error);
    },
  });
}

const sampleAgentEvent = {
  containerId: 'abc123def456',
  containerName: 'plex',
  image: 'plexinc/plex-media-server:latest',
  cpuPercent: 12.5,
  memoryUsage: 536870912,
  memoryLimit: 8589934592,
  memoryPercent: 6.25,
  networkRxBytesPerSec: 1024,
  networkTxBytesPerSec: 512,
  blockReadBytesPerSec: 2048,
  blockWriteBytesPerSec: 1024,
  timestamp: '2026-03-13T12:00:00.000Z',
};

describe('AgentStatsCollector', () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let abortController: AbortController;

  beforeEach(() => {
    mockDb = createMockDb();
    abortController = new AbortController();
  });

  it('has the correct name', () => {
    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, abortController,
    );
    expect(collector.name).toBe('AgentStatsCollector[homeserver]');
  });

  it('parses SSE events and inserts DockerStatsRow', async () => {
    const events = [sampleAgentEvent];
    const fetchFn = mock(async () =>
      new Response(createMockSSEStream(events), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, abortController, fetchFn,
    );
    mockDb.patchRepository(collector);

    // Run collection — the stream closes after one event, so collect() returns
    // We call collect() directly via the protected method
    await (collector as any).collect();

    expect(mockDb.insertedRows).toHaveLength(1);
    const row = mockDb.insertedRows[0][0];
    expect(row.host).toBe('homeserver');
    expect(row.container_id).toBe('abc123def456');
    expect(row.container_name).toBe('plex');
    expect(row.image).toBe('plexinc/plex-media-server:latest');
    expect(row.cpu_percent).toBe(12.5);
    expect(row.memory_usage).toBe(536870912);
    expect(row.memory_limit).toBe(8589934592);
    expect(row.memory_percent).toBe(6.25);
    expect(row.network_rx_bytes_per_sec).toBe(1024);
    expect(row.network_tx_bytes_per_sec).toBe(512);
    expect(row.block_io_read_bytes_per_sec).toBe(2048);
    expect(row.block_io_write_bytes_per_sec).toBe(1024);
  });

  it('sends Authorization header with bearer token', async () => {
    const fetchFn = mock(async () =>
      new Response(createMockSSEStream([]), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, abortController, fetchFn,
    );
    mockDb.patchRepository(collector);

    await (collector as any).collect();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const callArgs = fetchFn.mock.calls[0];
    const url = callArgs[0] as string;
    const opts = callArgs[1] as RequestInit;
    expect(url).toBe('http://192.168.1.10:9090/stats/stream');
    expect(opts.headers).toEqual({
      Authorization: 'Bearer test-token-uuid',
    });
  });

  it('passes abort signal to fetch', async () => {
    const fetchFn = mock(async (_url: string, opts: RequestInit) => {
      // Verify signal is passed
      expect(opts.signal).toBeDefined();
      return new Response(createMockSSEStream([]), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, abortController, fetchFn,
    );
    mockDb.patchRepository(collector);

    await (collector as any).collect();
  });

  it('upserts entity metadata for each container', async () => {
    const events = [sampleAgentEvent];
    const fetchFn = mock(async () =>
      new Response(createMockSSEStream(events), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, abortController, fetchFn,
    );
    mockDb.patchRepository(collector);

    await (collector as any).collect();

    // Should upsert name, image, and service_key for the container
    const nameUpsert = mockDb.upsertedMetadata.find(m => m.key === 'name');
    expect(nameUpsert).toBeDefined();
    expect(nameUpsert!.entity).toBe('homeserver/abc123def456');
    expect(nameUpsert!.value).toBe('plex');

    const imageUpsert = mockDb.upsertedMetadata.find(m => m.key === 'image');
    expect(imageUpsert).toBeDefined();
    expect(imageUpsert!.value).toBe('plexinc/plex-media-server:latest');
  });

  it('throws on non-200 response', async () => {
    const fetchFn = mock(async () =>
      new Response('Unauthorized', { status: 401 })
    );

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, abortController, fetchFn,
    );
    mockDb.patchRepository(collector);

    await expect((collector as any).collect()).rejects.toThrow('Agent returned 401');
  });

  it('handles multiple events in sequence', async () => {
    const event2 = {
      ...sampleAgentEvent,
      containerId: 'def789ghi012',
      containerName: 'sonarr',
      image: 'linuxserver/sonarr:latest',
      cpuPercent: 3.2,
    };
    const fetchFn = mock(async () =>
      new Response(createMockSSEStream([sampleAgentEvent, event2]), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, abortController, fetchFn,
    );
    mockDb.patchRepository(collector);

    await (collector as any).collect();

    expect(mockDb.insertedRows).toHaveLength(2);
    expect(mockDb.insertedRows[0][0].container_name).toBe('plex');
    expect(mockDb.insertedRows[1][0].container_name).toBe('sonarr');
  });

  it('stops processing when abort signal fires', async () => {
    // Create a stream that never closes — abort will terminate it
    const encoder = new TextEncoder();
    let controllerRef: ReadableStreamDefaultController<Uint8Array>;
    const neverEndingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        // Enqueue one event immediately
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(sampleAgentEvent)}\n\n`));
      },
    });

    const fetchFn = mock(async () =>
      new Response(neverEndingStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, abortController, fetchFn,
    );
    mockDb.patchRepository(collector);

    // Abort after a short delay
    setTimeout(() => abortController.abort(new DOMException('Shutdown', 'AbortError')), 50);

    // collect() should return once abort fires
    await (collector as any).collect();

    // At least one row should have been inserted before abort
    expect(mockDb.insertedRows.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/jared/homelab-manager && bun test src/worker/collectors/__tests__/agent-stats-collector.test.ts`
Expected: FAIL — `agent-stats-collector` module not found

- [ ] **Step 3: Implement AgentStatsCollector**

Create `src/worker/collectors/agent-stats-collector.ts`:

```typescript
import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';
import type { DockerStatsRow } from '@/types/docker';
import { BaseCollector } from './base-collector';

const DOCKER_SOURCE = 'docker';

/** Shape of SSE events emitted by the agent's GET /stats/stream endpoint */
interface AgentStatsEvent {
  containerId: string;
  containerName: string;
  image: string;
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  memoryPercent: number;
  networkRxBytesPerSec: number;
  networkTxBytesPerSec: number;
  blockReadBytesPerSec: number;
  blockWriteBytesPerSec: number;
  timestamp: string;
}

type FetchFn = typeof globalThis.fetch;

export class AgentStatsCollector extends BaseCollector {
  readonly name: string;
  private readonly host: ManagedHost;
  private readonly fetchFn: FetchFn;
  private knownContainers = new Set<string>();

  constructor(
    db: DatabaseClient,
    config: WorkerConfig,
    host: ManagedHost,
    abortController?: AbortController,
    fetchFn?: FetchFn,
  ) {
    super(db, config, abortController);
    this.host = host;
    this.name = `AgentStatsCollector[${host.name}]`;
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  protected async collect(): Promise<void> {
    const url = `${this.host.agent_url}/stats/stream`;
    this.debugLog(`[${this.name}] Connecting to ${url}`);

    const response = await this.fetchFn(url, {
      headers: {
        Authorization: `Bearer ${this.host.agent_token}`,
      },
      signal: this.signal,
    });

    if (!response.ok) {
      throw new Error(`Agent returned ${response.status}: ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('Agent response has no body');
    }

    this.resetBackoff();
    this.debugLog(`[${this.name}] Connected, reading SSE stream`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let statsReceived = 0;

    try {
      while (!this.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE messages (separated by double newlines)
        const messages = buffer.split('\n\n');
        // Keep the last incomplete chunk in the buffer
        buffer = messages.pop() ?? '';

        for (const message of messages) {
          if (this.signal.aborted) break;
          if (!message.trim()) continue;

          // Extract data from SSE "data: " prefix
          const dataLine = message
            .split('\n')
            .find(line => line.startsWith('data: '));

          if (!dataLine) continue;

          const jsonStr = dataLine.slice(6); // Remove "data: " prefix
          let event: AgentStatsEvent;
          try {
            event = JSON.parse(jsonStr);
          } catch {
            this.debugLog(`[${this.name}] Failed to parse SSE event: ${jsonStr.substring(0, 100)}`);
            continue;
          }

          // Skip error events from the agent
          if ('error' in event && !('containerId' in event)) continue;

          // Upsert entity metadata for new containers
          if (!this.knownContainers.has(event.containerId)) {
            const entityPath = `${this.host.name}/${event.containerId}`;
            await this.repository.upsertEntityMetadata(DOCKER_SOURCE, entityPath, 'name', event.containerName);
            await this.repository.upsertEntityMetadata(DOCKER_SOURCE, entityPath, 'image', event.image);
            // Use container name as service_key (agent doesn't have compose label info yet)
            await this.repository.upsertEntityMetadata(DOCKER_SOURCE, entityPath, 'service_key', event.containerName);
            this.knownContainers.add(event.containerId);
          }

          // Map agent event to DockerStatsRow
          const row: DockerStatsRow = {
            time: new Date(),
            host: this.host.name,
            container_id: event.containerId,
            container_name: event.containerName,
            image: event.image,
            cpu_percent: event.cpuPercent,
            memory_usage: event.memoryUsage,
            memory_limit: event.memoryLimit,
            memory_percent: event.memoryPercent,
            network_rx_bytes_per_sec: event.networkRxBytesPerSec,
            network_tx_bytes_per_sec: event.networkTxBytesPerSec,
            block_io_read_bytes_per_sec: event.blockReadBytesPerSec,
            block_io_write_bytes_per_sec: event.blockWriteBytesPerSec,
          };

          statsReceived++;
          const t0 = performance.now();
          await this.repository.insertDockerStats([row]);
          const writeMs = (performance.now() - t0).toFixed(1);
          this.dbDebugLog(
            `[${this.name}] Wrote stat for ${event.containerName} in ${writeMs}ms (total: ${statsReceived})`
          );
        }
      }
    } finally {
      reader.releaseLock();
      this.debugLog(
        `[${this.name}] Stream ended (${statsReceived} stats received, aborted=${this.signal.aborted})`
      );
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/jared/homelab-manager && bun test src/worker/collectors/__tests__/agent-stats-collector.test.ts`
Expected: All tests pass

- [ ] **Step 5: Run full test suite and typecheck**

Run: `cd /home/jared/homelab-manager && bun run typecheck && bun test`
Expected: No errors, all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/worker/collectors/agent-stats-collector.ts src/worker/collectors/__tests__/agent-stats-collector.test.ts
git commit -m "feat(worker): add AgentStatsCollector for SSE-based stats from managed hosts"
```

### Task 13: Worker startup integration

**Files:**
- Create: `src/worker/__tests__/collector-factory.test.ts` (if not exists, otherwise modify)
- Modify: `src/worker/collector-factory.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/worker/__tests__/collector-factory.test.ts`:

```typescript
import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Test the managed host integration in createCollectors.
// We test the logic that checks for managed hosts and creates AgentStatsCollectors.

describe('collector-factory — managed hosts', () => {
  it('creates AgentStatsCollector for each managed host when feature flag is on', async () => {
    // Mock the feature flag
    const mockIsEnabled = mock(() => true);
    const mockFindAll = mock(async () => [
      {
        id: 1,
        name: 'homeserver',
        agent_url: 'http://192.168.1.10:9090',
        agent_token_hash: '$2b$10$hash',
        agent_token: 'token-1',
        socket_proxy_url: 'tcp://192.168.1.10:2375',
        agent_version: '0.1.0',
        status: 'online',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);

    // Import and test createCollectorsForManagedHosts
    const { createCollectorsForManagedHosts } = await import('../collector-factory');

    const mockDb = {
      getPool: () => ({
        query: async () => ({ rows: [], rowCount: 0 }),
      }),
    } as any;

    const shutdownController = new AbortController();
    const stack = new AsyncDisposableStack();

    const workerConfig = {
      enabled: true,
      docker: { enabled: true },
      zfs: { enabled: false },
      proxmox: { enabled: false },
      collection: { interval: 1000 },
    } as any;

    const result = await createCollectorsForManagedHosts(
      mockDb, workerConfig, shutdownController, stack,
      mockIsEnabled, mockFindAll,
    );

    expect(result.collectors).toHaveLength(1);
    expect(result.collectors[0].name).toBe('AgentStatsCollector[homeserver]');
    expect(result.runners).toHaveLength(1);

    // Clean up
    shutdownController.abort();
    await stack.disposeAsync();
  });

  it('returns empty when feature flag is off', async () => {
    const mockIsEnabled = mock(() => false);
    const mockFindAll = mock(async () => []);

    const { createCollectorsForManagedHosts } = await import('../collector-factory');

    const mockDb = { getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }) } as any;
    const shutdownController = new AbortController();
    const stack = new AsyncDisposableStack();
    const workerConfig = {
      enabled: true,
      docker: { enabled: true },
      zfs: { enabled: false },
      proxmox: { enabled: false },
      collection: { interval: 1000 },
    } as any;

    const result = await createCollectorsForManagedHosts(
      mockDb, workerConfig, shutdownController, stack,
      mockIsEnabled, mockFindAll,
    );

    expect(result.collectors).toHaveLength(0);
    expect(result.runners).toHaveLength(0);
    expect(mockFindAll).not.toHaveBeenCalled();

    shutdownController.abort();
    await stack.disposeAsync();
  });

  it('returns empty when no managed hosts exist', async () => {
    const mockIsEnabled = mock(() => true);
    const mockFindAll = mock(async () => []);

    const { createCollectorsForManagedHosts } = await import('../collector-factory');

    const mockDb = { getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }) } as any;
    const shutdownController = new AbortController();
    const stack = new AsyncDisposableStack();
    const workerConfig = {
      enabled: true,
      docker: { enabled: true },
      zfs: { enabled: false },
      proxmox: { enabled: false },
      collection: { interval: 1000 },
    } as any;

    const result = await createCollectorsForManagedHosts(
      mockDb, workerConfig, shutdownController, stack,
      mockIsEnabled, mockFindAll,
    );

    expect(result.collectors).toHaveLength(0);
    expect(result.runners).toHaveLength(0);
    expect(mockFindAll).toHaveBeenCalledTimes(1);

    shutdownController.abort();
    await stack.disposeAsync();
  });

  it('skips managed hosts with no agent_token', async () => {
    const mockIsEnabled = mock(() => true);
    const mockFindAll = mock(async () => [
      {
        id: 1,
        name: 'homeserver',
        agent_url: 'http://192.168.1.10:9090',
        agent_token_hash: '$2b$10$hash',
        agent_token: null, // no plaintext token
        socket_proxy_url: 'tcp://192.168.1.10:2375',
        agent_version: '0.1.0',
        status: 'online',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);

    const { createCollectorsForManagedHosts } = await import('../collector-factory');

    const mockDb = { getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }) } as any;
    const shutdownController = new AbortController();
    const stack = new AsyncDisposableStack();
    const workerConfig = {
      enabled: true,
      docker: { enabled: true },
      zfs: { enabled: false },
      proxmox: { enabled: false },
      collection: { interval: 1000 },
    } as any;

    const result = await createCollectorsForManagedHosts(
      mockDb, workerConfig, shutdownController, stack,
      mockIsEnabled, mockFindAll,
    );

    expect(result.collectors).toHaveLength(0);

    shutdownController.abort();
    await stack.disposeAsync();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/jared/homelab-manager && bun test src/worker/__tests__/collector-factory.test.ts`
Expected: FAIL — `createCollectorsForManagedHosts` not exported

- [ ] **Step 3: Add `createCollectorsForManagedHosts` to collector-factory.ts**

Add to `src/worker/collector-factory.ts`:

```typescript
import { AgentStatsCollector } from './collectors/agent-stats-collector';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';

/**
 * Create AgentStatsCollectors for managed hosts when the management feature flag is enabled.
 * Uses dependency injection for the feature flag check and host lookup to enable testing
 * without database or env var dependencies.
 *
 * Managed hosts with no `agent_token` are skipped (token not yet stored — host was
 * provisioned before the migration that added the agent_token column).
 */
export async function createCollectorsForManagedHosts(
  db: DatabaseClient,
  workerConfig: WorkerConfig,
  shutdownController: AbortController,
  stack: AsyncDisposableStack,
  isManagementEnabled: () => boolean,
  findAllHosts: () => Promise<ManagedHost[]>,
): Promise<CollectorFactoryResult> {
  const collectors: BaseCollector[] = [];
  const runners: Promise<void>[] = [];

  if (!isManagementEnabled()) {
    return { collectors, runners };
  }

  const hosts = await findAllHosts();
  if (hosts.length === 0) {
    console.log('[Worker] Management feature enabled but no managed hosts found');
    return { collectors, runners };
  }

  console.log(`[Worker] Starting ${hosts.length} AgentStatsCollector(s) for managed hosts`);

  for (const host of hosts) {
    if (!host.agent_token) {
      console.log(`[Worker] Skipping managed host ${host.name}: no agent_token (provisioned before migration)`);
      continue;
    }

    console.log(`[Worker] Starting AgentStatsCollector for ${host.name} (${host.agent_url})`);
    const collector = stack.use(
      new AgentStatsCollector(db, workerConfig, host, shutdownController)
    );
    collectors.push(collector);
    runners.push(collector.run());
  }

  return { collectors, runners };
}
```

- [ ] **Step 4: Integrate into worker startup**

Modify `src/worker/collector.ts` to call `createCollectorsForManagedHosts` after `createCollectors`. Add to the worker's `main()` function, after the existing `createCollectors` call:

```typescript
import { createCollectorsForManagedHosts } from './collector-factory';
import { isDockerManagementEnabled } from '@/lib/config/feature-flags';
import { HostRepository } from '@/lib/database/repositories/host-repository';

// ... inside the { await using stack = ... } block, after createCollectors:

// Also start AgentStatsCollectors for managed hosts (if feature flag is on)
const hostRepo = new HostRepository(db.getPool());
const { collectors: managedCollectors, runners: managedRunners } = await createCollectorsForManagedHosts(
  db, workerConfig, shutdownController, stack,
  isDockerManagementEnabled,
  () => hostRepo.findAll(),
);
collectors.push(...managedCollectors);
runners.push(...managedRunners);
```

Both legacy `DockerCollector` (env var hosts) and `AgentStatsCollector` (managed hosts) run simultaneously in the same worker process. They write to the same `docker_stats` table using different host names, so their data is naturally separated.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /home/jared/homelab-manager && bun test src/worker/__tests__/collector-factory.test.ts`
Expected: All tests pass

- [ ] **Step 6: Run full test suite and typecheck**

Run: `cd /home/jared/homelab-manager && bun run typecheck && bun test`
Expected: No errors, all tests pass

- [ ] **Step 7: Commit**

```bash
git add src/worker/collector-factory.ts src/worker/__tests__/collector-factory.test.ts src/worker/collector.ts
git commit -m "feat(worker): integrate AgentStatsCollector for managed hosts into worker startup"
```

### Task 14: AgentStatsCollector reconnection and edge case tests

**Files:**
- Modify: `src/worker/collectors/__tests__/agent-stats-collector.test.ts`

- [ ] **Step 1: Add reconnection and edge case tests**

Add the following tests to the existing `agent-stats-collector.test.ts`:

```typescript
describe('AgentStatsCollector — reconnection', () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let abortController: AbortController;

  beforeEach(() => {
    mockDb = createMockDb();
    abortController = new AbortController();
  });

  it('run() reconnects after stream error with backoff', async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      if (callCount === 1) {
        // First call: error stream
        return new Response(
          createErrorSSEStream([sampleAgentEvent], new Error('Connection reset')),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      // Second call: abort to end the test
      abortController.abort(new DOMException('Shutdown', 'AbortError'));
      return new Response(createMockSSEStream([]), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, abortController, fetchFn,
    );
    mockDb.patchRepository(collector);

    // run() drives the reconnection loop via BaseCollector
    await collector.run();

    // Should have been called at least twice (initial + reconnect)
    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(2);
    // First event from the error stream should still have been inserted
    expect(mockDb.insertedRows.length).toBeGreaterThanOrEqual(1);
  });

  it('run() reconnects after non-200 response with backoff', async () => {
    let callCount = 0;
    const fetchFn = mock(async () => {
      callCount++;
      if (callCount <= 2) {
        return new Response('Service Unavailable', { status: 503 });
      }
      // Third call: abort
      abortController.abort(new DOMException('Shutdown', 'AbortError'));
      return new Response(createMockSSEStream([]), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, abortController, fetchFn,
    );
    mockDb.patchRepository(collector);

    await collector.run();

    // BaseCollector handles the exponential backoff and retries
    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('handles partial SSE messages across chunks', async () => {
    // Simulate a message split across two chunks
    const encoder = new TextEncoder();
    const part1 = `data: {"containerId":"abc123","containerNa`;
    const part2 = `me":"plex","image":"plexinc/plex","cpuPercent":5,"memoryUsage":100,"memoryLimit":1000,"memoryPercent":10,"networkRxBytesPerSec":0,"networkTxBytesPerSec":0,"blockReadBytesPerSec":0,"blockWriteBytesPerSec":0,"timestamp":"2026-03-13T12:00:00Z"}\n\n`;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(part1));
        controller.enqueue(encoder.encode(part2));
        controller.close();
      },
    });

    const fetchFn = mock(async () =>
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, abortController, fetchFn,
    );
    mockDb.patchRepository(collector);

    await (collector as any).collect();

    expect(mockDb.insertedRows).toHaveLength(1);
    expect(mockDb.insertedRows[0][0].container_name).toBe('plex');
  });

  it('skips malformed JSON in SSE events', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Malformed event
        controller.enqueue(encoder.encode(`data: {not valid json}\n\n`));
        // Valid event
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(sampleAgentEvent)}\n\n`));
        controller.close();
      },
    });

    const fetchFn = mock(async () =>
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, abortController, fetchFn,
    );
    mockDb.patchRepository(collector);

    await (collector as any).collect();

    // Only the valid event should be inserted
    expect(mockDb.insertedRows).toHaveLength(1);
    expect(mockDb.insertedRows[0][0].container_name).toBe('plex');
  });

  it('skips agent error events', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Agent error event
        controller.enqueue(encoder.encode(`event: error\ndata: {"error":"connection lost"}\n\n`));
        // Valid stats event
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(sampleAgentEvent)}\n\n`));
        controller.close();
      },
    });

    const fetchFn = mock(async () =>
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );

    const collector = new AgentStatsCollector(
      mockDb.db, defaultConfig, sampleHost, abortController, fetchFn,
    );
    mockDb.patchRepository(collector);

    await (collector as any).collect();

    expect(mockDb.insertedRows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd /home/jared/homelab-manager && bun test src/worker/collectors/__tests__/agent-stats-collector.test.ts`
Expected: All tests pass

- [ ] **Step 3: Run full test suite and typecheck**

Run: `cd /home/jared/homelab-manager && bun run typecheck && bun test`
Expected: No errors, all tests pass

- [ ] **Step 4: Commit**

```bash
git add src/worker/collectors/__tests__/agent-stats-collector.test.ts
git commit -m "test(worker): add reconnection and edge case tests for AgentStatsCollector"
```

---

## Summary

### Files Created
| File | Purpose |
|------|---------|
| `migrations/009_managed_hosts.sql` | Database migration for managed_hosts table |
| `migrations/010_managed_hosts_agent_token.sql` | Add agent_token column for worker auth |
| `src/worker/collectors/agent-stats-collector.ts` | SSE-based stats collector for managed host agents |
| `src/worker/collectors/__tests__/agent-stats-collector.test.ts` | AgentStatsCollector unit tests |
| `src/worker/__tests__/collector-factory.test.ts` | Managed host collector factory tests |
| `src/lib/database/repositories/host-repository.ts` | CRUD operations for managed_hosts |
| `src/lib/database/repositories/__tests__/host-repository.test.ts` | Repository unit tests |
| `src/lib/services/token-service.ts` | Token generation + bcrypt hashing |
| `src/lib/services/__tests__/token-service.test.ts` | Token service tests |
| `src/lib/config/feature-flags.ts` | Feature flag check |
| `src/lib/config/__tests__/feature-flags.test.ts` | Feature flag tests |
| `src/lib/services/agent-provisioning-service.ts` | Agent container provisioning via Dockerode |
| `src/lib/services/__tests__/agent-provisioning-service.test.ts` | Provisioning service tests |
| `src/lib/services/agent-health-service.ts` | Agent health check utility |
| `src/lib/services/__tests__/agent-health-service.test.ts` | Health check tests |
| `src/lib/services/agent-update-service.ts` | Agent update via socket proxy bypass |
| `src/lib/services/__tests__/agent-update-service.test.ts` | Update service tests |
| `src/data/hosts.functions.tsx` | Server functions for host management |
| `src/data/__tests__/hosts.functions.test.ts` | Server function export tests |
| `src/lib/mock/functions/hosts.functions.ts` | Mock functions for demo mode |

### Files Modified
| File | Change |
|------|--------|
| `src/lib/config/docker-config.ts` | Added migration path documentation |
| `src/lib/database/repositories/host-repository.ts` | Added `agent_token` field to ManagedHost and CreateHostInput |
| `src/worker/collector-factory.ts` | Added `createCollectorsForManagedHosts()` for managed host agent collectors |
| `src/worker/collector.ts` | Integrated managed host collector startup alongside legacy DockerCollectors |

### Key Design Decisions
- **Container name convention:** `homelab-agent-{hostname}` (matches spec)
- **Agent image:** `ghcr.io/homelab-manager/agent:latest` (prod) / `homelab-manager-agent:dev` (dev, via `NODE_ENV`)
- **Token:** `crypto.randomUUID()` for generation, `Bun.password.hash()` (bcrypt, cost 10) for storage
- **Socket proxy URL parsing:** `new URL()` to extract host/port for Dockerode connection
- **Health check:** 5s timeout for on-demand checks, 10s timeout after agent update
- **Error handling:** Container removal errors during host removal are logged but don't block DB cleanup. Failed provisioning rolls back (removes container + DB record).
- **Feature flag:** All server functions check `isDockerManagementEnabled()` and throw when off (consistent behavior)
- **SERIAL id:** PostgreSQL SERIAL (INT4) returns JavaScript numbers from node-postgres — no `Number()` coercion needed (unlike BIGINT which returns strings)
- **Agent URL:** Uses host IP extracted from socket proxy URL (not container DNS name, which is unreachable from outside the Docker network)
- **Health check retry:** Exponential backoff (500ms/1s/2s) instead of fixed delay, matching BaseCollector pattern
- **Fetch DI:** `checkAgentHealth` and `updateAgent` accept injectable `fetchFn` parameter for testing without global mock pollution
- **Zod validation:** Socket proxy URLs use custom `.refine()` to accept `tcp://` scheme (Zod `.url()` rejects non-http schemes)
- **Middleware:** Note added for future middleware injection pattern per CLAUDE.md rule 3
- **updated_at column:** Tracks last status/version/token change for debugging connectivity issues
- **Dynamic imports:** All server-only modules (pg, Dockerode, services) use `await import()` inside handlers per project convention
- **Agent token storage:** Plaintext `agent_token` stored in `managed_hosts` because the socket proxy URL already provides equivalent access; bcrypt hash retained for agent-side verification
- **AgentStatsCollector:** Extends `BaseCollector` for automatic exponential backoff on connection failures; uses `fetch()` with streaming response (not `EventSource`) for SSE consumption since `EventSource` doesn't support custom headers
- **Fetch DI in collector:** `AgentStatsCollector` accepts injectable `fetchFn` parameter for testing without network access, matching the pattern used by `checkAgentHealth` and `updateAgent`
- **No rate calculation:** Agent emits pre-computed rates via its own `RateCalculator`; the `AgentStatsCollector` maps fields directly without using `DockerRateCalculator`
- **Coexistence:** Legacy `DOCKER_HOST_N` env var hosts use `DockerCollector`, managed hosts use `AgentStatsCollector`; both write to `docker_stats` with different host names, run simultaneously in the same worker process
- **Managed host skipping:** Hosts provisioned before the `agent_token` migration (column is NULL) are skipped with a log message rather than failing the entire worker
