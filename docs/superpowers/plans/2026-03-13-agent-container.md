# Agent Container Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a lightweight Bun HTTP server that runs as a Docker container on each managed host, providing container stats streaming, log streaming, and Docker Compose stack deployment via a socket proxy.

**Architecture:** The agent is a standalone Bun application in `agent/` at the project root. It exposes an HTTP API authenticated via bearer token, connects to Docker through a socket proxy using Dockerode, and executes `docker compose` commands via `Bun.spawn()`. Stats and logs stream to homelab-manager via SSE.

**Tech Stack:** Bun runtime, Dockerode, `docker compose` CLI (v2), SSE streaming

**Spec:** `docs/superpowers/specs/2026-03-13-docker-stack-management-design.md` (Section 1: Agent Container)

---

## Chunk 1: Project Scaffolding & Health Endpoint

### Task 1: Initialize agent package

**Files:**
- Create: `agent/package.json`
- Create: `agent/tsconfig.json`
- Create: `agent/src/index.ts`

- [ ] **Step 1: Create `agent/package.json`**

```json
{
  "name": "@homelab-manager/agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/index.ts",
    "start": "bun src/index.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "dockerode": "^4.0.9"
  },
  "devDependencies": {
    "@types/dockerode": "^3.3.38",
    "@types/bun": "latest",
    "typescript": "^5.8.2"
  }
}
```

- [ ] **Step 2: Create `agent/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "types": ["bun"]
  },
  "include": ["src", "package.json"]
}
```

- [ ] **Step 3: Create minimal `agent/src/index.ts`**

```typescript
const PORT = Number(process.env.AGENT_PORT) || 9090;
const AGENT_TOKEN = process.env.AGENT_TOKEN;

if (!AGENT_TOKEN) {
  console.error('AGENT_TOKEN environment variable is required');
  process.exit(1);
}

console.error(`Agent starting on port ${PORT}`);

Bun.serve({
  port: PORT,
  fetch(request: Request): Response {
    return new Response('Not Found', { status: 404 });
  },
});

console.error(`Agent listening on port ${PORT}`);
```

- [ ] **Step 4: Install dependencies**

Run: `cd agent && bun install`
Expected: `node_modules/` created, lockfile generated

- [ ] **Step 5: Run typecheck**

Run: `cd agent && bun run typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add agent/package.json agent/tsconfig.json agent/src/index.ts agent/bun.lock
git commit -m "feat(agent): scaffold agent package with Bun server entry point"
```

---

### Task 2: Token authentication middleware

**Files:**
- Create: `agent/src/middleware.ts`
- Create: `agent/src/__tests__/middleware.test.ts`
- Modify: `agent/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `agent/src/__tests__/middleware.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { authenticateRequest } from '../middleware';

describe('authenticateRequest', () => {
  const validToken = 'test-token-123';

  test('returns null for valid bearer token', () => {
    const headers = new Headers({ Authorization: `Bearer ${validToken}` });
    const result = authenticateRequest(headers, validToken);
    expect(result).toBeNull();
  });

  test('returns 401 response for missing Authorization header', () => {
    const headers = new Headers();
    const result = authenticateRequest(headers, validToken);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(401);
  });

  test('returns 401 response for invalid token', () => {
    const headers = new Headers({ Authorization: 'Bearer wrong-token' });
    const result = authenticateRequest(headers, validToken);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(401);
  });

  test('returns 401 for non-Bearer auth scheme', () => {
    const headers = new Headers({ Authorization: `Basic ${validToken}` });
    const result = authenticateRequest(headers, validToken);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(401);
  });

  test('handles GET /health without authentication', () => {
    const headers = new Headers();
    const result = authenticateRequest(headers, validToken, '/health');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && bun test src/__tests__/middleware.test.ts`
Expected: FAIL — `authenticateRequest` not found

- [ ] **Step 3: Implement authentication**

Create `agent/src/middleware.ts`:

```typescript
export function authenticateRequest(
  headers: Headers,
  expectedToken: string,
  pathname?: string
): Response | null {
  // Health endpoint is public for bootstrap verification
  if (pathname === '/health') {
    return null;
  }

  const authHeader = headers.get('Authorization');
  if (!authHeader) {
    return new Response('Unauthorized', { status: 401 });
  }

  const [scheme, token] = authHeader.split(' ', 2);
  if (scheme !== 'Bearer' || token !== expectedToken) {
    return new Response('Unauthorized', { status: 401 });
  }

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && bun test src/__tests__/middleware.test.ts`
Expected: All 5 tests pass

- [ ] **Step 5: Wire middleware into index.ts**

Update `agent/src/index.ts`:

```typescript
import { authenticateRequest } from './middleware';

const PORT = Number(process.env.AGENT_PORT) || 9090;
const AGENT_TOKEN = process.env.AGENT_TOKEN;

if (!AGENT_TOKEN) {
  console.error('AGENT_TOKEN environment variable is required');
  process.exit(1);
}

Bun.serve({
  port: PORT,
  fetch(request: Request): Response {
    const url = new URL(request.url);

    const authError = authenticateRequest(
      request.headers,
      AGENT_TOKEN,
      url.pathname
    );
    if (authError) return authError;

    return new Response('Not Found', { status: 404 });
  },
});

console.error(`Agent listening on port ${PORT}`);
```

- [ ] **Step 6: Run typecheck**

Run: `cd agent && bun run typecheck`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add agent/src/middleware.ts agent/src/__tests__/middleware.test.ts agent/src/index.ts
git commit -m "feat(agent): add bearer token authentication middleware"
```

---

### Task 3: Health endpoint

**Files:**
- Create: `agent/src/routes/health.ts`
- Create: `agent/src/__tests__/health.test.ts`
- Modify: `agent/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `agent/src/__tests__/health.test.ts`:

```typescript
import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { handleHealth } from '../routes/health';

describe('handleHealth', () => {
  test('returns 200 with agent version and status', async () => {
    const mockDocker = {
      version: mock(() =>
        Promise.resolve({
          Version: '24.0.7',
          ApiVersion: '1.43',
        })
      ),
    };

    const response = await handleHealth(mockDocker as any);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.agentVersion).toBe('0.1.0');
    expect(body.docker.version).toBe('24.0.7');
    expect(body.docker.apiVersion).toBe('1.43');
  });

  test('returns 503 when Docker is unreachable', async () => {
    const mockDocker = {
      version: mock(() => Promise.reject(new Error('Connection refused'))),
    };

    const response = await handleHealth(mockDocker as any);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe('unhealthy');
    expect(body.error).toBe('Connection refused');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && bun test src/__tests__/health.test.ts`
Expected: FAIL — `handleHealth` not found

- [ ] **Step 3: Implement health handler**

Create `agent/src/routes/health.ts`:

```typescript
import type Dockerode from 'dockerode';
import pkg from '../../package.json';

const { version } = pkg;

export async function handleHealth(docker: Dockerode): Promise<Response> {
  try {
    const dockerVersion = await docker.version();
    return Response.json(
      {
        status: 'healthy',
        agentVersion: version,
        docker: {
          version: dockerVersion.Version,
          apiVersion: dockerVersion.ApiVersion,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    return Response.json(
      {
        status: 'unhealthy',
        agentVersion: version,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 503 }
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && bun test src/__tests__/health.test.ts`
Expected: All 2 tests pass

- [ ] **Step 5: Wire health route into index.ts**

Update `agent/src/index.ts` to add routing:

```typescript
import Dockerode from 'dockerode';
import { authenticateRequest } from './middleware';
import { handleHealth } from './routes/health';

const PORT = Number(process.env.AGENT_PORT) || 9090;
const AGENT_TOKEN = process.env.AGENT_TOKEN;
const DOCKER_HOST = process.env.DOCKER_HOST;

if (!AGENT_TOKEN) {
  console.error('AGENT_TOKEN environment variable is required');
  process.exit(1);
}

if (!DOCKER_HOST) {
  console.error('DOCKER_HOST environment variable is required');
  process.exit(1);
}

const dockerUrl = new URL(DOCKER_HOST.replace('tcp://', 'http://'));
const docker = new Dockerode({
  host: dockerUrl.hostname,
  port: Number(dockerUrl.port),
  protocol: dockerUrl.protocol === 'https:' ? 'https' : 'http',
});

Bun.serve({
  port: PORT,
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    const authError = authenticateRequest(
      request.headers,
      AGENT_TOKEN,
      url.pathname
    );
    if (authError) return authError;

    if (url.pathname === '/health' && request.method === 'GET') {
      return handleHealth(docker);
    }

    return new Response('Not Found', { status: 404 });
  },
});

console.error(`Agent listening on port ${PORT}`);
```

- [ ] **Step 6: Run all tests and typecheck**

Run: `cd agent && bun run typecheck && bun test`
Expected: All tests pass, no type errors

- [ ] **Step 7: Commit**

```bash
git add agent/src/routes/health.ts agent/src/__tests__/health.test.ts agent/src/index.ts
git commit -m "feat(agent): add health endpoint with Docker version reporting"
```

---

## Chunk 2: Container Stats Streaming

### Task 4: Stats SSE stream

**Files:**
- Create: `agent/src/routes/stats.ts`
- Create: `agent/src/rate-calculator.ts`
- Create: `agent/src/__tests__/stats.test.ts`
- Create: `agent/src/__tests__/rate-calculator.test.ts`

- [ ] **Step 1: Write rate calculator tests**

Create `agent/src/__tests__/rate-calculator.test.ts`:

```typescript
import { describe, expect, test, beforeEach, spyOn } from 'bun:test';
import { RateCalculator } from '../rate-calculator';

describe('RateCalculator', () => {
  let calculator: RateCalculator;
  let nowMock: ReturnType<typeof spyOn>;
  let currentTime: number;

  beforeEach(() => {
    calculator = new RateCalculator();
    currentTime = 1000000;
    nowMock = spyOn(Date, 'now').mockImplementation(() => currentTime);
  });

  test('returns null on first call (no previous data)', () => {
    const stats = createMockStats({ cpuDelta: 100, systemDelta: 1000 });
    const result = calculator.calculate('container1', stats);
    expect(result).toBeNull();
  });

  test('calculates CPU percentage on second call', () => {
    const stats1 = createMockStats({
      cpuTotal: 100,
      systemCpu: 1000,
      onlineCpus: 4,
    });
    calculator.calculate('container1', stats1);

    currentTime += 1000; // 1 second later
    const stats2 = createMockStats({
      cpuTotal: 200,
      systemCpu: 2000,
      onlineCpus: 4,
    });
    const result = calculator.calculate('container1', stats2);

    expect(result).not.toBeNull();
    // (200-100) / (2000-1000) * 4 * 100 = 40%
    expect(result!.cpuPercent).toBeCloseTo(40);
  });

  test('calculates memory percentage', () => {
    const stats1 = createMockStats({ memUsage: 512, memLimit: 1024 });
    calculator.calculate('container1', stats1);

    currentTime += 1000;
    const stats2 = createMockStats({ memUsage: 512, memLimit: 1024 });
    const result = calculator.calculate('container1', stats2);

    expect(result).not.toBeNull();
    expect(result!.memoryPercent).toBeCloseTo(50);
  });

  test('calculates network bytes per second', () => {
    const stats1 = createMockStats({ rxBytes: 1000, txBytes: 500 });
    calculator.calculate('container1', stats1);

    currentTime += 1000; // 1 second later
    const stats2 = createMockStats({ rxBytes: 2000, txBytes: 1500 });
    const result = calculator.calculate('container1', stats2);

    expect(result).not.toBeNull();
    // (2000-1000) / 1s = 1000 bytes/sec
    expect(result!.networkRxBytesPerSec).toBe(1000);
    // (1500-500) / 1s = 1000 bytes/sec
    expect(result!.networkTxBytesPerSec).toBe(1000);
  });

  test('remove clears cached data for a container', () => {
    const stats = createMockStats({});
    calculator.calculate('container1', stats);
    calculator.remove('container1');
    const result = calculator.calculate('container1', stats);
    expect(result).toBeNull();
  });

  test('clear removes all cached data', () => {
    calculator.calculate('c1', createMockStats({}));
    calculator.calculate('c2', createMockStats({}));
    calculator.clear();
    expect(calculator.calculate('c1', createMockStats({}))).toBeNull();
    expect(calculator.calculate('c2', createMockStats({}))).toBeNull();
  });
});

function createMockStats(overrides: {
  cpuTotal?: number;
  cpuDelta?: number;
  systemCpu?: number;
  systemDelta?: number;
  onlineCpus?: number;
  memUsage?: number;
  memLimit?: number;
  rxBytes?: number;
  txBytes?: number;
  readBytes?: number;
  writeBytes?: number;
}) {
  return {
    read: new Date().toISOString(),
    cpu_stats: {
      cpu_usage: {
        total_usage: overrides.cpuTotal ?? 0,
      },
      system_cpu_usage: overrides.systemCpu ?? 0,
      online_cpus: overrides.onlineCpus ?? 1,
    },
    precpu_stats: {
      cpu_usage: {
        total_usage: (overrides.cpuTotal ?? 0) - (overrides.cpuDelta ?? 0),
      },
      system_cpu_usage:
        (overrides.systemCpu ?? 0) - (overrides.systemDelta ?? 0),
    },
    memory_stats: {
      usage: overrides.memUsage ?? 0,
      limit: overrides.memLimit ?? 1,
    },
    networks: {
      eth0: {
        rx_bytes: overrides.rxBytes ?? 0,
        tx_bytes: overrides.txBytes ?? 0,
      },
    },
    blkio_stats: {
      io_service_bytes_recursive: [
        { op: 'read', value: overrides.readBytes ?? 0 },
        { op: 'write', value: overrides.writeBytes ?? 0 },
      ],
    },
  };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && bun test src/__tests__/rate-calculator.test.ts`
Expected: FAIL — `RateCalculator` not found

- [ ] **Step 3: Implement rate calculator**

Create `agent/src/rate-calculator.ts`:

```typescript
export interface ContainerRates {
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  memoryPercent: number;
  networkRxBytesPerSec: number;
  networkTxBytesPerSec: number;
  blockReadBytesPerSec: number;
  blockWriteBytesPerSec: number;
}

interface PreviousStats {
  cpuTotal: number;
  systemCpu: number;
  rxBytes: number;
  txBytes: number;
  readBytes: number;
  writeBytes: number;
  timestamp: number;
}

export class RateCalculator {
  private previous = new Map<string, PreviousStats>();

  calculate(containerId: string, stats: any): ContainerRates | null {
    const now = Date.now();
    const cpuTotal = stats.cpu_stats?.cpu_usage?.total_usage ?? 0;
    const systemCpu = stats.cpu_stats?.system_cpu_usage ?? 0;
    const onlineCpus = stats.cpu_stats?.online_cpus ?? 1;
    const memUsage = stats.memory_stats?.usage ?? 0;
    const memLimit = stats.memory_stats?.limit ?? 1;

    let rxBytes = 0;
    let txBytes = 0;
    if (stats.networks) {
      for (const net of Object.values(stats.networks) as any[]) {
        rxBytes += net.rx_bytes ?? 0;
        txBytes += net.tx_bytes ?? 0;
      }
    }

    let readBytes = 0;
    let writeBytes = 0;
    for (const entry of stats.blkio_stats?.io_service_bytes_recursive ?? []) {
      const op = entry.op?.toLowerCase();
      if (op === 'read') readBytes += entry.value;
      if (op === 'write') writeBytes += entry.value;
    }

    const prev = this.previous.get(containerId);
    this.previous.set(containerId, {
      cpuTotal,
      systemCpu,
      rxBytes,
      txBytes,
      readBytes,
      writeBytes,
      timestamp: now,
    });

    if (!prev) return null;

    const timeDeltaSec = (now - prev.timestamp) / 1000;
    if (timeDeltaSec <= 0) return null;

    const cpuDelta = cpuTotal - prev.cpuTotal;
    const systemDelta = systemCpu - prev.systemCpu;
    const cpuPercent =
      systemDelta > 0 ? (cpuDelta / systemDelta) * onlineCpus * 100 : 0;

    return {
      cpuPercent,
      memoryUsage: memUsage,
      memoryLimit: memLimit,
      memoryPercent: memLimit > 0 ? (memUsage / memLimit) * 100 : 0,
      networkRxBytesPerSec: (rxBytes - prev.rxBytes) / timeDeltaSec,
      networkTxBytesPerSec: (txBytes - prev.txBytes) / timeDeltaSec,
      blockReadBytesPerSec: (readBytes - prev.readBytes) / timeDeltaSec,
      blockWriteBytesPerSec: (writeBytes - prev.writeBytes) / timeDeltaSec,
    };
  }

  remove(containerId: string): void {
    this.previous.delete(containerId);
  }

  clear(): void {
    this.previous.clear();
  }
}
```

- [ ] **Step 4: Run rate calculator tests**

Run: `cd agent && bun test src/__tests__/rate-calculator.test.ts`
Expected: All 6 tests pass

- [ ] **Step 5: Commit**

```bash
git add agent/src/rate-calculator.ts agent/src/__tests__/rate-calculator.test.ts
git commit -m "feat(agent): add rate calculator for container stats"
```

- [ ] **Step 6: Write stats stream tests**

Create `agent/src/__tests__/stats.test.ts`:

```typescript
import { describe, expect, test, mock } from 'bun:test';
import { handleStatsStream } from '../routes/stats';

describe('handleStatsStream', () => {
  test('returns SSE response with correct headers', () => {
    const mockDocker = {
      listContainers: mock(() => Promise.resolve([])),
    };
    const request = new Request('http://localhost/stats/stream');
    const response = handleStatsStream(mockDocker as any, request);

    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(response.headers.get('Connection')).toBe('keep-alive');
  });

  test('returns 200 status', () => {
    const mockDocker = {
      listContainers: mock(() => Promise.resolve([])),
    };
    const request = new Request('http://localhost/stats/stream');
    const response = handleStatsStream(mockDocker as any, request);

    expect(response.status).toBe(200);
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `cd agent && bun test src/__tests__/stats.test.ts`
Expected: FAIL — `handleStatsStream` not found

- [ ] **Step 8: Implement stats stream handler**

Create `agent/src/routes/stats.ts`:

```typescript
import type Dockerode from 'dockerode';
import { RateCalculator } from '../rate-calculator';

const POLL_INTERVAL_MS = 1000;

export function handleStatsStream(
  docker: Dockerode,
  request: Request
): Response {
  let closed = false;
  const rateCalculator = new RateCalculator();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      request.signal.addEventListener('abort', () => {
        closed = true;
        rateCalculator.clear();
        controller.close();
      });

      // Snapshot-based polling: fetch one stats snapshot per container per tick.
      // This avoids long-lived streams that block container change detection.
      const poll = async () => {
        while (!closed) {
          try {
            const containers = await docker.listContainers({ all: false });

            const snapshots = await Promise.allSettled(
              containers.map(async (container) => {
                const dockerContainer = docker.getContainer(container.Id);
                const stats = await dockerContainer.stats({ stream: false });
                return { container, stats };
              })
            );

            for (const result of snapshots) {
              if (closed) break;
              if (result.status !== 'fulfilled') continue;

              const { container, stats } = result.value;
              const id = container.Id;
              const name = container.Names[0]?.replace(/^\//, '') ?? id;
              const rates = rateCalculator.calculate(id, stats);
              if (!rates) continue;

              const data = {
                containerId: id,
                containerName: name,
                image: container.Image,
                ...rates,
                timestamp: new Date().toISOString(),
              };

              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
              );
            }
          } catch (error) {
            if (!closed) {
              const msg = error instanceof Error ? error.message : String(error);
              controller.enqueue(
                encoder.encode(
                  `event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`
                )
              );
            }
          }

          if (!closed) {
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          }
        }
      };

      poll();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
```

- [ ] **Step 9: Run stats tests**

Run: `cd agent && bun test src/__tests__/stats.test.ts`
Expected: All 2 tests pass

- [ ] **Step 10: Wire stats route into index.ts**

Add to the fetch handler in `agent/src/index.ts`, after the health route:

```typescript
import { handleStatsStream } from './routes/stats';

// ... inside fetch handler:
if (url.pathname === '/stats/stream' && request.method === 'GET') {
  return handleStatsStream(docker, request);
}
```

- [ ] **Step 11: Run all tests and typecheck**

Run: `cd agent && bun run typecheck && bun test`
Expected: All tests pass, no type errors

- [ ] **Step 12: Commit**

```bash
git add agent/src/routes/stats.ts agent/src/__tests__/stats.test.ts agent/src/__tests__/rate-calculator.test.ts agent/src/index.ts
git commit -m "feat(agent): add container stats SSE streaming endpoint"
```

---

## Chunk 3: Container Logs & Stack Deployment

### Task 5: Container log streaming

**Files:**
- Create: `agent/src/routes/logs.ts`
- Create: `agent/src/__tests__/logs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `agent/src/__tests__/logs.test.ts`:

```typescript
import { describe, expect, test, mock } from 'bun:test';
import { handleLogStream } from '../routes/logs';

describe('handleLogStream', () => {
  test('returns SSE response with correct headers', () => {
    const mockContainer = {
      logs: mock(() => Promise.resolve(Buffer.from(''))),
      inspect: mock(() => Promise.resolve({ Config: { Tty: false } })),
    };
    const mockDocker = {
      getContainer: mock(() => mockContainer),
    };
    const request = new Request('http://localhost/logs/abc123');
    const response = handleLogStream(mockDocker as any, 'abc123', request);

    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(response.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && bun test src/__tests__/logs.test.ts`
Expected: FAIL — `handleLogStream` not found

- [ ] **Step 3: Implement log stream handler**

Create `agent/src/routes/logs.ts`:

```typescript
import type Dockerode from 'dockerode';

export function handleLogStream(
  docker: Dockerode,
  containerId: string,
  request: Request
): Response {
  let closed = false;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      request.signal.addEventListener('abort', () => {
        closed = true;
        controller.close();
      });

      try {
        const container = docker.getContainer(containerId);
        const info = await container.inspect();
        const isTty = info.Config?.Tty ?? false;

        const logStream = (await container.logs({
          follow: true,
          stdout: true,
          stderr: true,
          tail: 200,
          timestamps: true,
        })) as NodeJS.ReadableStream;

        logStream.on('data', (chunk: Buffer) => {
          if (closed) return;

          const lines = isTty
            ? parseTtyChunk(chunk)
            : parseMuxedChunk(chunk);

          for (const line of lines) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(line)}\n\n`)
            );
          }
        });

        logStream.on('end', () => {
          if (!closed) {
            closed = true;
            controller.close();
          }
        });

        logStream.on('error', (error: Error) => {
          if (!closed) {
            controller.enqueue(
              encoder.encode(
                `event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`
              )
            );
            closed = true;
            controller.close();
          }
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`
          )
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

interface LogLine {
  stream: 'stdout' | 'stderr';
  text: string;
}

function parseTtyChunk(chunk: Buffer): LogLine[] {
  return chunk
    .toString()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((text) => ({ stream: 'stdout' as const, text }));
}

function parseMuxedChunk(chunk: Buffer): LogLine[] {
  const lines: LogLine[] = [];
  let offset = 0;

  while (offset + 8 <= chunk.length) {
    const streamType = chunk[offset] === 2 ? 'stderr' : 'stdout';
    const size = chunk.readUInt32BE(offset + 4);
    offset += 8;

    if (offset + size > chunk.length) break;

    const text = chunk.subarray(offset, offset + size).toString().trimEnd();
    if (text.length > 0) {
      lines.push({ stream: streamType, text });
    }
    offset += size;
  }

  return lines;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && bun test src/__tests__/logs.test.ts`
Expected: All tests pass

- [ ] **Step 5: Wire logs route into index.ts**

Add to the fetch handler in `agent/src/index.ts`:

```typescript
import { handleLogStream } from './routes/logs';

// ... inside fetch handler:
const logsMatch = url.pathname.match(/^\/logs\/([a-zA-Z0-9]+)$/);
if (logsMatch && request.method === 'GET') {
  return handleLogStream(docker, logsMatch[1], request);
}
```

- [ ] **Step 6: Commit**

```bash
git add agent/src/routes/logs.ts agent/src/__tests__/logs.test.ts agent/src/index.ts
git commit -m "feat(agent): add container log streaming endpoint"
```

---

### Task 6: Stack deploy endpoint

**Files:**
- Create: `agent/src/routes/stacks.ts`
- Create: `agent/src/__tests__/stacks.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `agent/src/__tests__/stacks.test.ts`:

```typescript
import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import {
  handleStackDeploy,
  handleStackTeardown,
  handleStackRestart,
  handleStackStatus,
} from '../routes/stacks';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

const TEST_STACKS_DIR = join(import.meta.dir, '../../.test-stacks');

const emptyStream = () => new ReadableStream({ start(c) { c.close(); } });

const noopSpawn = mock(() => ({
  exited: Promise.resolve(0),
  stdout: emptyStream(),
  stderr: emptyStream(),
}));

const successSpawn = mock(() => ({
  exited: Promise.resolve(0),
  stdout: emptyStream(),
  stderr: emptyStream(),
}));

beforeEach(() => {
  mkdirSync(TEST_STACKS_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_STACKS_DIR, { recursive: true, force: true });
});

describe('handleStackDeploy', () => {
  test('writes compose file and .env to stack directory', async () => {
    const mockSpawn = mock(() => ({
      exited: Promise.resolve(0),
      stdout: new ReadableStream(),
      stderr: new ReadableStream(),
    }));

    const body = {
      stack: 'plex',
      composeContent: 'services:\n  plex:\n    image: plexinc/pms-docker',
      envContent: 'PLEX_CLAIM=claim-abc123',
    };

    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, mockSpawn as any);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.status).toBe('success');

    const composePath = join(TEST_STACKS_DIR, 'plex', 'docker-compose.yml');
    expect(existsSync(composePath)).toBe(true);
    expect(readFileSync(composePath, 'utf-8')).toBe(body.composeContent);

    const envPath = join(TEST_STACKS_DIR, 'plex', '.env');
    expect(existsSync(envPath)).toBe(true);
    expect(readFileSync(envPath, 'utf-8')).toBe(body.envContent);
  });

  test('returns 400 for missing stack name', async () => {
    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ composeContent: 'services: {}' }),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, noopSpawn as any);
    expect(response.status).toBe(400);
  });

  test('returns 500 when docker compose fails', async () => {
    const mockSpawn = mock(() => ({
      exited: Promise.resolve(1),
      stdout: new ReadableStream(),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('Error: image not found'));
          controller.close();
        },
      }),
    }));

    const body = {
      stack: 'plex',
      composeContent: 'services:\n  plex:\n    image: invalid',
    };

    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, mockSpawn as any);
    expect(response.status).toBe(500);
  });
});

describe('handleStackDeploy — path traversal', () => {
  test('rejects stack names with path traversal', async () => {
    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: '../../etc', composeContent: 'services: {}' }),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, noopSpawn as any);
    expect(response.status).toBe(400);
  });

  test('rejects stack names with dots', async () => {
    const request = new Request('http://localhost/stacks/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: '.hidden', composeContent: 'services: {}' }),
    });

    const response = await handleStackDeploy(request, TEST_STACKS_DIR, noopSpawn as any);
    expect(response.status).toBe(400);
  });
});

describe('handleStackTeardown', () => {
  test('returns 400 for missing stack name', async () => {
    const request = new Request('http://localhost/stacks/teardown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const response = await handleStackTeardown(request, TEST_STACKS_DIR, noopSpawn as any);
    expect(response.status).toBe(400);
  });

  test('returns 404 for nonexistent stack', async () => {
    const request = new Request('http://localhost/stacks/teardown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'nonexistent' }),
    });

    const response = await handleStackTeardown(request, TEST_STACKS_DIR, noopSpawn as any);
    expect(response.status).toBe(404);
  });

  test('runs docker compose down for existing stack', async () => {
    mkdirSync(join(TEST_STACKS_DIR, 'plex'), { recursive: true });
    await Bun.write(join(TEST_STACKS_DIR, 'plex', 'docker-compose.yml'), 'services: {}');

    const request = new Request('http://localhost/stacks/teardown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'plex' }),
    });

    const response = await handleStackTeardown(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.status).toBe('success');
  });
});

describe('handleStackRestart', () => {
  test('returns 400 for missing stack name', async () => {
    const request = new Request('http://localhost/stacks/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const response = await handleStackRestart(request, TEST_STACKS_DIR, noopSpawn as any);
    expect(response.status).toBe(400);
  });

  test('returns 404 for nonexistent stack', async () => {
    const request = new Request('http://localhost/stacks/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'nonexistent' }),
    });

    const response = await handleStackRestart(request, TEST_STACKS_DIR, noopSpawn as any);
    expect(response.status).toBe(404);
  });

  test('runs docker compose restart for existing stack', async () => {
    mkdirSync(join(TEST_STACKS_DIR, 'traefik'), { recursive: true });
    await Bun.write(join(TEST_STACKS_DIR, 'traefik', 'docker-compose.yml'), 'services: {}');

    const request = new Request('http://localhost/stacks/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stack: 'traefik' }),
    });

    const response = await handleStackRestart(request, TEST_STACKS_DIR, successSpawn as any);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.status).toBe('success');
  });
});

describe('handleStackStatus', () => {
  test('returns list of stacks with directories', async () => {
    mkdirSync(join(TEST_STACKS_DIR, 'plex'), { recursive: true });
    await Bun.write(
      join(TEST_STACKS_DIR, 'plex', 'docker-compose.yml'),
      'services: {}'
    );

    const statusSpawn = mock(() => ({
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify([
              { Name: 'plex-app-1', State: 'running', Service: 'app' },
            ]))
          );
          controller.close();
        },
      }),
      stderr: new ReadableStream(),
    }));

    const response = await handleStackStatus(TEST_STACKS_DIR, statusSpawn as any);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.stacks).toBeArray();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && bun test src/__tests__/stacks.test.ts`
Expected: FAIL — imports not found

- [ ] **Step 3: Implement stack handlers**

Create `agent/src/routes/stacks.ts`:

```typescript
import { mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const VALID_STACK_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function validateStackName(name: string): Response | null {
  if (!name || !VALID_STACK_NAME.test(name)) {
    return Response.json(
      { error: 'Invalid stack name. Use only alphanumeric, hyphens, and underscores.' },
      { status: 400 }
    );
  }
  return null;
}

type SpawnFn = typeof Bun.spawn;

export async function handleStackDeploy(
  request: Request,
  stacksDir: string,
  spawn: SpawnFn = Bun.spawn
): Promise<Response> {
  let body: { stack?: string; composeContent?: string; envContent?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.stack || !body.composeContent) {
    return Response.json(
      { error: 'Missing required fields: stack, composeContent' },
      { status: 400 }
    );
  }

  const nameError = validateStackName(body.stack);
  if (nameError) return nameError;

  const stackDir = join(stacksDir, body.stack);
  mkdirSync(stackDir, { recursive: true });

  await Bun.write(join(stackDir, 'docker-compose.yml'), body.composeContent);

  if (body.envContent) {
    await Bun.write(join(stackDir, '.env'), body.envContent);
  }

  const proc = spawn({
    cmd: [
      'docker',
      'compose',
      '-f',
      join(stackDir, 'docker-compose.yml'),
      'up',
      '-d',
      '--remove-orphans',
    ],
    cwd: stackDir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, COMPOSE_PROJECT_NAME: body.stack },
  });

  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  const stdout = await new Response(proc.stdout).text();

  if (exitCode !== 0) {
    return Response.json(
      { status: 'failed', exitCode, stderr, stdout },
      { status: 500 }
    );
  }

  return Response.json({ status: 'success', stdout, stderr });
}

export async function handleStackTeardown(
  request: Request,
  stacksDir: string,
  spawn: SpawnFn = Bun.spawn
): Promise<Response> {
  let body: { stack?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.stack) {
    return Response.json(
      { error: 'Missing required field: stack' },
      { status: 400 }
    );
  }

  const nameError = validateStackName(body.stack);
  if (nameError) return nameError;

  const stackDir = join(stacksDir, body.stack);
  const composePath = join(stackDir, 'docker-compose.yml');

  if (!existsSync(composePath)) {
    return Response.json(
      { error: `Stack '${body.stack}' not found` },
      { status: 404 }
    );
  }

  const proc = spawn({
    cmd: ['docker', 'compose', '-f', composePath, 'down'],
    cwd: stackDir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, COMPOSE_PROJECT_NAME: body.stack },
  });

  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  const stdout = await new Response(proc.stdout).text();

  if (exitCode !== 0) {
    return Response.json(
      { status: 'failed', exitCode, stderr, stdout },
      { status: 500 }
    );
  }

  return Response.json({ status: 'success', stdout, stderr });
}

export async function handleStackRestart(
  request: Request,
  stacksDir: string,
  spawn: SpawnFn = Bun.spawn
): Promise<Response> {
  let body: { stack?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.stack) {
    return Response.json(
      { error: 'Missing required field: stack' },
      { status: 400 }
    );
  }

  const nameError2 = validateStackName(body.stack);
  if (nameError2) return nameError2;

  const stackDir = join(stacksDir, body.stack);
  const composePath = join(stackDir, 'docker-compose.yml');

  if (!existsSync(composePath)) {
    return Response.json(
      { error: `Stack '${body.stack}' not found` },
      { status: 404 }
    );
  }

  const proc = spawn({
    cmd: ['docker', 'compose', '-f', composePath, 'restart'],
    cwd: stackDir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, COMPOSE_PROJECT_NAME: body.stack },
  });

  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  const stdout = await new Response(proc.stdout).text();

  if (exitCode !== 0) {
    return Response.json(
      { status: 'failed', exitCode, stderr, stdout },
      { status: 500 }
    );
  }

  return Response.json({ status: 'success', stdout, stderr });
}

export async function handleStackStatus(
  stacksDir: string,
  spawn: SpawnFn = Bun.spawn
): Promise<Response> {
  if (!existsSync(stacksDir)) {
    return Response.json({ stacks: [] });
  }

  const entries = readdirSync(stacksDir, { withFileTypes: true });
  const stacks = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const composePath = join(stacksDir, entry.name, 'docker-compose.yml');
    if (!existsSync(composePath)) continue;

    let containers: any[] = [];
    try {
      const proc = spawn({
        cmd: [
          'docker',
          'compose',
          '-f',
          composePath,
          'ps',
          '--format',
          'json',
        ],
        cwd: join(stacksDir, entry.name),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, COMPOSE_PROJECT_NAME: entry.name },
      });

      const exitCode = await proc.exited;
      if (exitCode === 0) {
        const output = await new Response(proc.stdout).text();
        if (output.trim()) {
          containers = JSON.parse(output);
        }
      }
    } catch {
      // Stack may not be running
    }

    stacks.push({
      name: entry.name,
      containers,
    });
  }

  return Response.json({ stacks });
}
```

- [ ] **Step 4: Run tests**

Run: `cd agent && bun test src/__tests__/stacks.test.ts`
Expected: All tests pass

- [ ] **Step 5: Wire stack routes into index.ts**

Add to the fetch handler in `agent/src/index.ts`:

```typescript
import {
  handleStackDeploy,
  handleStackTeardown,
  handleStackRestart,
  handleStackStatus,
} from './routes/stacks';

const STACKS_DIR = process.env.STACKS_DIR || '/opt/homelab-manager/stacks';

// ... inside fetch handler:
if (url.pathname === '/stacks/deploy' && request.method === 'POST') {
  return handleStackDeploy(request, STACKS_DIR);
}
if (url.pathname === '/stacks/teardown' && request.method === 'POST') {
  return handleStackTeardown(request, STACKS_DIR);
}
if (url.pathname === '/stacks/restart' && request.method === 'POST') {
  return handleStackRestart(request, STACKS_DIR);
}
if (url.pathname === '/stacks/status' && request.method === 'GET') {
  return handleStackStatus(STACKS_DIR);
}
```

- [ ] **Step 6: Run all tests and typecheck**

Run: `cd agent && bun run typecheck && bun test`
Expected: All tests pass, no type errors

- [ ] **Step 7: Commit**

```bash
git add agent/src/routes/stacks.ts agent/src/__tests__/stacks.test.ts agent/src/routes/logs.ts agent/src/__tests__/logs.test.ts agent/src/index.ts
git commit -m "feat(agent): add stack deploy/teardown/restart/status endpoints"
```

---

## Chunk 4: Dockerfile & Dev Compose Integration

### Task 7: Agent Dockerfile

**Files:**
- Create: `agent/Dockerfile`
- Create: `agent/.dockerignore`

- [ ] **Step 1: Create `.dockerignore`**

Create `agent/.dockerignore`:

```
node_modules
.test-stacks
dist
*.test.ts
__tests__
```

- [ ] **Step 2: Create `Dockerfile`**

Create `agent/Dockerfile`:

```dockerfile
FROM oven/bun:1 AS base

# Pin versions for reproducible builds
ARG DOCKER_CLI_VERSION=24.0.9
ARG DOCKER_COMPOSE_VERSION=2.32.4

# Install Docker CLI (static binary — no daemon) and Docker Compose v2 plugin
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates && \
    # Docker CLI static binary
    curl -fsSL "https://download.docker.com/linux/static/stable/$(uname -m)/docker-${DOCKER_CLI_VERSION}.tgz" | \
    tar xz --strip-components=1 -C /usr/local/bin docker/docker && \
    # Docker Compose v2 plugin
    mkdir -p /usr/local/lib/docker/cli-plugins && \
    curl -fsSL "https://github.com/docker/compose/releases/download/v${DOCKER_COMPOSE_VERSION}/docker-compose-linux-$(uname -m)" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose && \
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose && \
    # Cleanup
    apt-get purge -y curl && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tsconfig.json package.json ./

ENV AGENT_PORT=9090
ENV STACKS_DIR=/opt/homelab-manager/stacks

EXPOSE 9090

RUN mkdir -p /opt/homelab-manager/stacks

CMD ["bun", "src/index.ts"]
```

- [ ] **Step 3: Commit**

```bash
git add agent/Dockerfile agent/.dockerignore
git commit -m "feat(agent): add Dockerfile with docker compose CLI"
```

---

### Task 8: Dev compose integration

**Files:**
- Modify: `docker-compose.local.yml` (or create `docker-compose.dev.yml` — check which exists)

- [ ] **Step 1: Check existing compose file**

Run: `ls -la docker-compose*.yml`
Note which file to modify.

- [ ] **Step 2: Create agent dev compose override file**

Create `docker-compose.agent.yml` — a separate compose file activated via `docker compose -f docker-compose.local.yml -f docker-compose.agent.yml up`:

```yaml
# Docker management feature services (use with DOCKER_MANAGEMENT_FEATURE_FLAG=true)
# Usage: docker compose -f docker-compose.local.yml -f docker-compose.agent.yml up
services:
  socket-proxy:
    image: tecnativa/docker-socket-proxy
    environment:
      CONTAINERS: 1
      IMAGES: 1
      NETWORKS: 1
      VOLUMES: 1
      POST: 1
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - homelab-network

  agent:
    build:
      context: ./agent
      dockerfile: Dockerfile
    environment:
      DOCKER_HOST: "tcp://socket-proxy:2375"
      AGENT_TOKEN: "dev-agent-token"
      AGENT_PORT: "9090"
      STACKS_DIR: "/opt/homelab-manager/stacks"
    ports:
      - "9090:9090"
    volumes:
      - homelab-stacks:/opt/homelab-manager/stacks
      - ./agent/src:/app/src  # Hot reload in dev
    depends_on:
      - socket-proxy
    networks:
      - homelab-network

  openbao:
    image: openbao/openbao
    command: server -dev
    environment:
      BAO_DEV_ROOT_TOKEN_ID: "dev-root-token"
    ports:
      - "8200:8200"
    networks:
      - homelab-network

volumes:
  homelab-stacks:
```

- [ ] **Step 3: Update `.env.example` with new env vars**

Add the following to `.env.example`:

```bash
# Docker Management (feature-flagged, undocumented)
# DOCKER_MANAGEMENT_FEATURE_FLAG=true
# OPENBAO_URL=http://openbao:8200
```

- [ ] **Step 4: Run typecheck on main project to ensure nothing broke**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add docker-compose.agent.yml .env.example
git commit -m "feat(agent): add agent dev compose with socket proxy and openbao"
```

---

### Task 9: Final integration — complete index.ts router

**Files:**
- Modify: `agent/src/index.ts`

- [ ] **Step 1: Review and finalize the complete index.ts**

Ensure `agent/src/index.ts` has all routes wired up correctly with the final shape:

```typescript
import Dockerode from 'dockerode';
import { authenticateRequest } from './middleware';
import { handleHealth } from './routes/health';
import { handleStatsStream } from './routes/stats';
import { handleLogStream } from './routes/logs';
import {
  handleStackDeploy,
  handleStackTeardown,
  handleStackRestart,
  handleStackStatus,
} from './routes/stacks';

const PORT = Number(process.env.AGENT_PORT) || 9090;
const AGENT_TOKEN = process.env.AGENT_TOKEN;
const DOCKER_HOST = process.env.DOCKER_HOST;
const STACKS_DIR = process.env.STACKS_DIR || '/opt/homelab-manager/stacks';

if (!AGENT_TOKEN) {
  console.error('AGENT_TOKEN environment variable is required');
  process.exit(1);
}

if (!DOCKER_HOST) {
  console.error('DOCKER_HOST environment variable is required');
  process.exit(1);
}

const dockerUrl = new URL(DOCKER_HOST.replace('tcp://', 'http://'));
const docker = new Dockerode({
  host: dockerUrl.hostname,
  port: Number(dockerUrl.port),
  protocol: dockerUrl.protocol === 'https:' ? 'https' : 'http',
});

Bun.serve({
  port: PORT,
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    const authError = authenticateRequest(
      request.headers,
      AGENT_TOKEN,
      url.pathname
    );
    if (authError) return authError;

    // Health (public)
    if (url.pathname === '/health' && request.method === 'GET') {
      return handleHealth(docker);
    }

    // Stats streaming
    if (url.pathname === '/stats/stream' && request.method === 'GET') {
      return handleStatsStream(docker, request);
    }

    // Log streaming
    const logsMatch = url.pathname.match(/^\/logs\/([a-zA-Z0-9]+)$/);
    if (logsMatch && request.method === 'GET') {
      return handleLogStream(docker, logsMatch[1], request);
    }

    // Stack management
    if (url.pathname === '/stacks/deploy' && request.method === 'POST') {
      return handleStackDeploy(request, STACKS_DIR);
    }
    if (url.pathname === '/stacks/teardown' && request.method === 'POST') {
      return handleStackTeardown(request, STACKS_DIR);
    }
    if (url.pathname === '/stacks/restart' && request.method === 'POST') {
      return handleStackRestart(request, STACKS_DIR);
    }
    if (url.pathname === '/stacks/status' && request.method === 'GET') {
      return handleStackStatus(STACKS_DIR);
    }

    return new Response('Not Found', { status: 404 });
  },
});

console.error(`Agent listening on port ${PORT}`);
```

- [ ] **Step 2: Run all agent tests and typecheck**

Run: `cd agent && bun run typecheck && bun test`
Expected: All tests pass, no type errors

- [ ] **Step 3: Run main project typecheck and tests**

Run: `bun run typecheck && bun test`
Expected: Main project unaffected, all existing tests pass

- [ ] **Step 4: Commit**

```bash
git add agent/src/index.ts
git commit -m "feat(agent): finalize router with all endpoints wired"
```
