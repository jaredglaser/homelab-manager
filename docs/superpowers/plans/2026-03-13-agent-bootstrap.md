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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  agent_url: 'http://homeserver-agent:9090',
  agent_token_hash: '$2b$10$hashedtoken',
  socket_proxy_url: 'tcp://192.168.1.10:2375',
  agent_version: '0.1.0',
  status: 'online',
  created_at: new Date('2026-01-01T00:00:00Z'),
};

const sampleRow = {
  id: '1', // BIGINT returns string from pg
  name: 'homeserver',
  agent_url: 'http://homeserver-agent:9090',
  agent_token_hash: '$2b$10$hashedtoken',
  socket_proxy_url: 'tcp://192.168.1.10:2375',
  agent_version: '0.1.0',
  status: 'online',
  created_at: new Date('2026-01-01T00:00:00Z'),
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
        agent_url: 'http://homeserver-agent:9090',
        agent_token_hash: '$2b$10$hashedtoken',
        socket_proxy_url: 'tcp://192.168.1.10:2375',
      };

      const result = await repo.create(input);

      expect(result.id).toBe(1);
      expect(result.name).toBe('homeserver');
      expect(result.agent_url).toBe('http://homeserver-agent:9090');
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
        { ...sampleRow, id: '2', name: 'beta' },
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

    it('returns host when found and converts id from string', async () => {
      mock.pushResult([sampleRow]);
      const result = await repo.findById(1);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(1);
    });
  });

  describe('updateStatus', () => {
    it('updates the status field', async () => {
      mock.pushResult([]); // UPDATE returns no rows
      await repo.updateStatus(1, 'offline');
      expect(mock.queries[0].sql).toContain('UPDATE managed_hosts');
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
}

export interface CreateHostInput {
  name: string;
  agent_url: string;
  agent_token_hash: string;
  socket_proxy_url: string;
}

interface ManagedHostRow {
  id: string; // PostgreSQL SERIAL returns string via node-postgres
  name: string;
  agent_url: string;
  agent_token_hash: string;
  socket_proxy_url: string;
  agent_version: string | null;
  status: string;
  created_at: Date;
}

function rowToHost(row: ManagedHostRow): ManagedHost {
  return {
    id: Number(row.id),
    name: row.name,
    agent_url: row.agent_url,
    agent_token_hash: row.agent_token_hash,
    socket_proxy_url: row.socket_proxy_url,
    agent_version: row.agent_version,
    status: row.status,
    created_at: row.created_at,
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
    return rowToHost(result.rows[0] as ManagedHostRow);
  }

  async findAll(): Promise<ManagedHost[]> {
    const result = await this.pool.query(
      'SELECT * FROM managed_hosts ORDER BY name ASC'
    );
    return (result.rows as ManagedHostRow[]).map(rowToHost);
  }

  async findByName(name: string): Promise<ManagedHost | null> {
    const result = await this.pool.query(
      'SELECT * FROM managed_hosts WHERE name = $1',
      [name]
    );
    return result.rows.length > 0 ? rowToHost(result.rows[0] as ManagedHostRow) : null;
  }

  async findById(id: number): Promise<ManagedHost | null> {
    const result = await this.pool.query(
      'SELECT * FROM managed_hosts WHERE id = $1',
      [id]
    );
    return result.rows.length > 0 ? rowToHost(result.rows[0] as ManagedHostRow) : null;
  }

  async updateStatus(id: number, status: string): Promise<void> {
    await this.pool.query(
      'UPDATE managed_hosts SET status = $1 WHERE id = $2',
      [status, id]
    );
  }

  async updateAgentVersion(id: number, version: string): Promise<void> {
    await this.pool.query(
      'UPDATE managed_hosts SET agent_version = $1 WHERE id = $2',
      [version, id]
    );
  }

  async updateTokenHash(id: number, tokenHash: string): Promise<void> {
    await this.pool.query(
      'UPDATE managed_hosts SET agent_token_hash = $1 WHERE id = $2',
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

    it('returns the agent URL and container name', async () => {
      const result = await service.provision(mockDocker.docker, defaultOptions);
      expect(result.containerName).toBe('homelab-agent-homeserver');
      expect(result.agentUrl).toContain('9090');
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

    // The agent URL uses the container name for Docker network resolution.
    // The socket proxy host is extracted from the URL for the agent's reachable address.
    const agentUrl = `http://${containerName}:${options.agentPort}`;

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
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { checkAgentHealth, type AgentHealthResult } from '../agent-health-service';

// Save original fetch
const originalFetch = globalThis.fetch;

describe('agent-health-service', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('checkAgentHealth', () => {
    it('returns healthy result when agent responds with 200', async () => {
      globalThis.fetch = mock(async () =>
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

      const result = await checkAgentHealth('http://agent:9090');

      expect(result.healthy).toBe(true);
      expect(result.version).toBe('0.1.0');
      expect(result.dockerVersion).toBe('24.0.7');
      expect(result.error).toBeUndefined();
    });

    it('returns unhealthy result when agent responds with non-200', async () => {
      globalThis.fetch = mock(async () =>
        new Response('Internal Server Error', { status: 500 })
      ) as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090');

      expect(result.healthy).toBe(false);
      expect(result.error).toContain('500');
    });

    it('returns unhealthy result when fetch throws (network error)', async () => {
      globalThis.fetch = mock(async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090');

      expect(result.healthy).toBe(false);
      expect(result.error).toContain('ECONNREFUSED');
    });

    it('calls the correct URL with /health path', async () => {
      let calledUrl = '';
      globalThis.fetch = mock(async (input: string | URL | Request) => {
        calledUrl = typeof input === 'string' ? input : input.toString();
        return new Response(
          JSON.stringify({ status: 'ok', version: '0.1.0' }),
          { status: 200 }
        );
      }) as typeof fetch;

      await checkAgentHealth('http://agent:9090');
      expect(calledUrl).toBe('http://agent:9090/health');
    });

    it('uses a timeout via AbortSignal', async () => {
      globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
        expect(init?.signal).toBeDefined();
        return new Response(
          JSON.stringify({ status: 'ok', version: '0.1.0' }),
          { status: 200 }
        );
      }) as typeof fetch;

      await checkAgentHealth('http://agent:9090');
    });

    it('returns unhealthy on timeout (AbortError)', async () => {
      globalThis.fetch = mock(async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }) as typeof fetch;

      const result = await checkAgentHealth('http://agent:9090');

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
 */
export async function checkAgentHealth(
  agentUrl: string,
  timeoutMs: number = HEALTH_CHECK_TIMEOUT_MS
): Promise<AgentHealthResult> {
  try {
    const response = await fetch(`${agentUrl}/health`, {
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
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { AgentUpdateService } from '../agent-update-service';

// Save original fetch for health checks
const originalFetch = globalThis.fetch;

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

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('updateAgent', () => {
    it('pulls the new image via socket proxy', async () => {
      // Mock health check
      globalThis.fetch = mock(async () =>
        new Response(JSON.stringify({ status: 'ok', version: '0.2.0' }), { status: 200 })
      ) as typeof fetch;

      await service.updateAgent(mockDocker.docker, 'homeserver', 'ghcr.io/org/homelab-manager-agent:latest');

      expect(mockDocker.pulledImages).toContain('ghcr.io/org/homelab-manager-agent:latest');
    });

    it('stops and removes the old container', async () => {
      globalThis.fetch = mock(async () =>
        new Response(JSON.stringify({ status: 'ok', version: '0.2.0' }), { status: 200 })
      ) as typeof fetch;

      await service.updateAgent(mockDocker.docker, 'homeserver', 'ghcr.io/org/homelab-manager-agent:latest');

      expect(mockDocker.stoppedContainers).toHaveLength(1);
      expect(mockDocker.removedContainers).toHaveLength(1);
    });

    it('creates a new container with the same config', async () => {
      globalThis.fetch = mock(async () =>
        new Response(JSON.stringify({ status: 'ok', version: '0.2.0' }), { status: 200 })
      ) as typeof fetch;

      await service.updateAgent(mockDocker.docker, 'homeserver', 'ghcr.io/org/homelab-manager-agent:latest');

      expect(mockDocker.createdContainers).toHaveLength(1);
      expect(mockDocker.createdContainers[0].name).toBe('homelab-agent-homeserver');
    });

    it('starts the new container', async () => {
      globalThis.fetch = mock(async () =>
        new Response(JSON.stringify({ status: 'ok', version: '0.2.0' }), { status: 200 })
      ) as typeof fetch;

      await service.updateAgent(mockDocker.docker, 'homeserver', 'ghcr.io/org/homelab-manager-agent:latest');

      expect(mockDocker.startedContainers).toHaveLength(1);
    });

    it('preserves env vars from the old container', async () => {
      globalThis.fetch = mock(async () =>
        new Response(JSON.stringify({ status: 'ok', version: '0.2.0' }), { status: 200 })
      ) as typeof fetch;

      await service.updateAgent(mockDocker.docker, 'homeserver', 'ghcr.io/org/homelab-manager-agent:latest');

      const config = mockDocker.createdContainers[0].config;
      const env = config.Env as string[];
      expect(env).toContainEqual('AGENT_TOKEN=existing-token');
      expect(env).toContainEqual('DOCKER_HOST=tcp://192.168.1.10:2375');
    });

    it('returns the new version from health check', async () => {
      globalThis.fetch = mock(async () =>
        new Response(JSON.stringify({ status: 'ok', version: '0.2.0' }), { status: 200 })
      ) as typeof fetch;

      const result = await service.updateAgent(
        mockDocker.docker,
        'homeserver',
        'ghcr.io/org/homelab-manager-agent:latest'
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
const POST_UPDATE_HEALTH_CHECK_DELAY_MS = 2000;
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
    newImage: string
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

    // 6. Wait briefly, then verify health
    await new Promise((resolve) => setTimeout(resolve, POST_UPDATE_HEALTH_CHECK_DELAY_MS));

    // Derive agent URL from port bindings
    const agentPort = this.extractAgentPort(oldHostConfig.PortBindings);
    const agentUrl = `http://${containerName}:${agentPort}`;
    const healthResult = await checkAgentHealth(agentUrl, POST_UPDATE_HEALTH_CHECK_TIMEOUT_MS);

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
import { describe, it, expect } from 'bun:test';

/**
 * Server function tests for host management.
 *
 * These test the exported function signatures and input validation schemas.
 * Full integration tests require a running database and are covered by
 * the E2E test suite. Unit tests here verify the module exports and
 * schema validation shapes.
 */
describe('hosts.functions module', () => {
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

const addHostSchema = z.object({
  name: z.string().min(1).max(100),
  socketProxyUrl: z.string().url(),
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
 * 7. Update status to 'online' or 'degraded'
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

    // Health check (wait a moment for agent startup)
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const healthResult = await checkAgentHealth(provisionResult.agentUrl);

    const status = healthResult.healthy ? 'online' : 'degraded';
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
 */
export const listHosts = createServerFn()
  .handler(async (): Promise<HostListItem[]> => {
    const { isDockerManagementEnabled } = await import(
      '@/lib/config/feature-flags'
    );
    if (!isDockerManagementEnabled()) {
      return [];
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
    agentUrl: 'http://homelab-agent-homeserver:9090',
    socketProxyUrl: 'http://192.168.1.10:2375',
    agentVersion: '0.1.0',
    status: 'online',
    createdAt: '2026-01-15T10:00:00Z',
  },
  {
    id: 2,
    name: 'media-server',
    agentUrl: 'http://homelab-agent-media-server:9090',
    socketProxyUrl: 'http://192.168.1.20:2375',
    agentVersion: '0.1.0',
    status: 'online',
    createdAt: '2026-02-01T14:30:00Z',
  },
];

export async function addHost(_data: {
  name: string;
  socketProxyUrl: string;
  agentPort?: number;
}): Promise<AddHostResult> {
  const newHost: HostListItem = {
    id: mockHosts.length + 1,
    name: _data.name,
    agentUrl: `http://homelab-agent-${_data.name}:${_data.agentPort ?? 9090}`,
    socketProxyUrl: _data.socketProxyUrl,
    agentVersion: '0.1.0',
    status: 'online',
    createdAt: new Date().toISOString(),
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

## Summary

### Files Created
| File | Purpose |
|------|---------|
| `migrations/009_managed_hosts.sql` | Database migration for managed_hosts table |
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

### Key Design Decisions
- **Container name convention:** `homelab-agent-{hostname}` (matches spec)
- **Agent image:** `ghcr.io/homelab-manager/agent:latest` (prod) / `homelab-manager-agent:dev` (dev, via `NODE_ENV`)
- **Token:** `crypto.randomUUID()` for generation, `Bun.password.hash()` (bcrypt, cost 10) for storage
- **Socket proxy URL parsing:** `new URL()` to extract host/port for Dockerode connection
- **Health check:** 5s timeout for on-demand checks, 10s timeout after agent update
- **Error handling:** Container removal errors during host removal are logged but don't block DB cleanup
- **Feature flag:** All server functions check `isDockerManagementEnabled()` and throw or return empty when off
- **SERIAL id:** PostgreSQL SERIAL (not BIGINT), but `Number()` conversion is applied in `rowToHost()` for safety since node-postgres returns numeric types as strings for large values
- **Dynamic imports:** All server-only modules (pg, Dockerode, services) use `await import()` inside handlers per project convention
