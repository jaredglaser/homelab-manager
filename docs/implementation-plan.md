# Universal Agent Architecture — Implementation Plan

> **Context:** This plan implements the architecture described in [`docs/openbao-architecture.md`](./openbao-architecture.md). Read that document first — it is the source of truth for all design decisions.
>
> **Constraint:** All hosts have Docker. There is no non-Docker deployment path. The updater sidecar lives in the monorepo as a `updater/` package.

---

## Phase 1 — Agent Stack & User-Managed Deployment

### 1.1 Updater Sidecar (`updater/`)

Create a new package at `updater/` in the monorepo. This is a minimal Bun application (~5MB image target) that manages agent container lifecycle.

**Files to create:**
- `updater/package.json` — Bun package, no external dependencies beyond Dockerode
- `updater/tsconfig.json` — Strict TypeScript, mirrors agent config
- `updater/src/index.ts` — Entry point
- `updater/src/updater.ts` — Core logic: poll GHCR, compare digests, pull + recreate
- `updater/src/health-reporter.ts` — Reports update status to agent via localhost
- `updater/Dockerfile` — Multi-stage build, minimal final image
- `updater/src/__tests__/` — Tests with coverage enforcement matching agent (96%/99%)

**Behavior:**
1. On startup, read `AGENT_CONTAINER_NAME` (default: `hlm-agent`) and `AGENT_IMAGE` env vars
2. Every N minutes (configurable via `UPDATE_CHECK_INTERVAL`, default 30m), check GHCR for new image digest
3. If digest differs: pull new image → stop agent → recreate with same config → health check → if unhealthy, rollback to previous image
4. Expose no ports, no API. Communicates with Docker daemon via mounted socket only
5. Log updates via `console.info` (operational messages only, per CLAUDE.md rules)

**Testing:** Unit test the digest comparison, recreate logic, and rollback flow. Mock Dockerode. Run `bun test` and `bun run typecheck` in `updater/`.

### 1.2 Reference Agent Stack Compose Template

Create a compose template that the UI will use to generate host-specific files.

**File to create:** `src/lib/templates/agent-stack-compose.ts`

This is a TypeScript module that exports a function to generate a compose YAML string given host configuration:

```typescript
interface AgentStackConfig {
  agentToken: string;
  agentImage: string;       // e.g. "ghcr.io/your-org/homelab-manager-agent:latest"
  updaterImage: string;     // e.g. "ghcr.io/your-org/homelab-manager-updater:latest"
  capabilities: {
    docker: boolean;        // include socket-proxy service
    zfs: boolean;           // include ZFS volume mounts + hlm-zfs user config
  };
  // ZFS-specific (only when capabilities.zfs is true)
  hlmZfsUid?: number;
  hlmZfsGid?: number;
  dockerGid?: number;       // only when both docker and zfs capabilities
}

export function generateAgentStackCompose(config: AgentStackConfig): string
```

The generated compose file should match the [Reference Agent Stack](./openbao-architecture.md#reference-agent-stack) in the architecture doc. Key points:
- Socket proxy uses `tecnativa/docker-socket-proxy` with restrictive env vars
- `agent-internal` network is `internal: true`
- Only the updater mounts the Docker socket
- Agent connects to socket proxy via `DOCKER_HOST=tcp://socket-proxy:2375`
- All services use `restart: unless-stopped`

**Testing:** Snapshot tests for each capability combination (docker-only, zfs-only, docker+zfs). Verify the generated YAML is valid.

### 1.3 Database Migration — Drop `socket_proxy_url`, Add `capabilities`

**File to create:** `migrations/014_agent_stack_migration.sql`

```sql
ALTER TABLE managed_hosts
  DROP COLUMN IF EXISTS socket_proxy_url,
  ADD COLUMN IF NOT EXISTS capabilities JSONB DEFAULT '{}';
```

Check the current `managed_hosts` schema first — look at existing migrations and `host-repository.ts` to confirm column names.

### 1.4 Update Host Repository

**File to edit:** `src/lib/database/repositories/host-repository.ts`

- Remove all `socket_proxy_url` references
- Add `capabilities` JSONB column to queries (INSERT, SELECT, UPDATE)
- Type the capabilities as `{ docker?: boolean; zfs?: boolean; zfs_tier?: number }`

### 1.5 Update Host Types and Utilities

**File to edit:** `src/lib/hosts/host-utils.ts`
- Remove `socket_proxy_url` from type definitions
- Add `capabilities` field

**File to edit:** `src/data/hosts.functions.tsx`
- Remove `socketProxyUrl` from Zod schemas and server functions
- Replace provisioning flow (`handleAddHost`) with:
  1. Generate token (`crypto.randomUUID()`)
  2. Return compose file content (via `generateAgentStackCompose`)
  3. New `handleVerifyHost` server function: call agent `/health`, store token in OpenBao, INSERT into `managed_hosts` with capabilities from health response

### 1.6 Remove Dockerode-Based Provisioning

**Files to edit/delete:**
- `src/lib/services/agent-provisioning-service.ts` — Gut the Dockerode provisioning logic. Replace with compose file generation. If the file is mostly provisioning, delete it and create a simpler service.
- `src/lib/services/agent-update-service.ts` — Remove Dockerode-based update logic. Keep version-check logic (compare agent's reported version vs latest GHCR tag) for UI warnings. The updater sidecar handles actual updates.

### 1.7 UI — Add Host Flow

The UI flow changes from "provision via Dockerode" to "generate compose file + verify connection." Update the relevant components (find them by tracing from `hosts.functions.tsx`):

1. **Step 1:** User selects host capabilities (Docker, ZFS, or both)
2. **Step 2:** If ZFS selected, show commands to run on the host:
   ```
   # Create the hlm-zfs user:
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin hlm-zfs
   sudo groupadd -f zfs
   sudo usermod -aG zfs hlm-zfs

   # Get the UID/GID (enter these below):
   id hlm-zfs
   ```
   User enters `HLM_ZFS_UID`, `HLM_ZFS_GID`, and optionally `DOCKER_GID`
3. **Step 3:** UI generates and displays the compose file + `.env` file. Copy button for each.
4. **Step 4:** User enters the agent URL (host:port). Click "Verify Connection" → calls `handleVerifyHost`.
5. **Step 5:** Success — host appears in the dashboard.

### 1.8 Run Tests and Typecheck

After all Phase 1 changes:
```bash
bun run typecheck
bun test
cd agent && bun run typecheck
cd agent && bun test
```

Fix any failures. Ensure 96%/99% coverage is maintained.

---

## Phase 2 — Agent ZFS Support

### 2.1 Agent Capability Detection

**File to edit:** `agent/src/routes/health.ts`

Update the `/health` endpoint to detect and report capabilities:

```typescript
{
  version: "x.y.z",
  capabilities: {
    docker: { available: boolean, version?: string },
    zfs: { available: boolean, version?: string, tier: number, permissions: string[] }
  }
}
```

**Detection logic:**
- **Docker:** Check if `DOCKER_HOST` env var is set and socket proxy responds to ping
- **ZFS:** Check if `zpool` binary exists (`which zpool`), then parse `zfs allow` output to determine tier
  - Tier 1: `zpool` exists and is executable (read-only via group)
  - Tier 2: delegation includes `snapshot`, `hold`, `send`, `rollback`, `destroy`

**File to create:** `agent/src/lib/zfs-capabilities.ts` — capability detection logic

### 2.2 Agent ZFS Endpoints

**File to create:** `agent/src/routes/zfs.ts`

Two endpoints:

**`GET /zfs/stats/stream`** — SSE endpoint streaming `zpool iostat` output
- Run `zpool iostat -v 1` as a subprocess
- Parse output into structured JSON (pool, vdev, disk hierarchy)
- Stream as SSE events
- Kill subprocess on client disconnect
- Return 503 if ZFS capability not available

**`GET /zfs/pools`** — REST endpoint listing pools
- Run `zpool list -Hp` and `zpool status`
- Return structured JSON with pool properties
- Return 503 if ZFS capability not available

**Register routes in `agent/src/index.ts`** — add ZFS route handlers, guarded by capability check.

**Testing:** Mock `Bun.spawn` for zpool commands. Test SSE streaming, parsing, disconnect cleanup, and 503 when ZFS unavailable.

### 2.3 Agent Client — ZFS Methods

**File to edit:** `src/lib/clients/agent-client.ts`

Add methods:
- `streamZfsStats(signal: AbortSignal): AsyncIterable<ZfsStatsEvent>` — connects to `/zfs/stats/stream` SSE
- `getZfsPools(): Promise<ZfsPool[]>` — calls `/zfs/pools`

### 2.4 Worker — Refactor ZFS Collection

**File to edit:** `src/worker/collectors/zfs-collector.ts`

Refactor to use the agent client instead of SSH:
- Remove all SSH/ssh2 imports and logic
- Use `agentClient.streamZfsStats()` instead
- The collector should look similar to `agent-stats-collector.ts` in structure

**File to edit:** `src/worker/collector-factory.ts`

- Remove `ZFS_HOST_*` env var parsing (lines ~62–81)
- Create ZFS collectors based on `managed_hosts` rows where `capabilities->>'zfs' = 'true'`
- Query managed hosts from DB instead of reading env vars

### 2.5 Remove SSH Infrastructure

**Files to delete:**
- `src/lib/clients/ssh-client.ts`
- `src/middleware/ssh-middleware.ts` (verify this path — may be at a different location)

**Files to edit:**
- `src/lib/config/zfs-config.ts` — Remove SSH credential fields. If the file is only SSH config, delete it entirely.
- Any imports of the deleted files — search for `ssh-client` and `ssh-middleware` across the codebase
- `package.json` — Remove `ssh2` from dependencies (and `@types/ssh2` from devDependencies if present)

### 2.6 Remove `ZFS_HOST_*` Environment Variables

**Files to edit:**
- `.env.example` — Remove `ZFS_HOST_*` entries (lines ~31–38)
- `docker-compose.yml` — Remove `ZFS_HOST_*` env var definitions
- `docker-compose.dev.yml` — Remove `ZFS_HOST_*` template
- `docker-compose.local.yml` — Remove any ZFS SSH references

### 2.7 Remove Central Socket Proxy

**Files to edit:**
- `docker-compose.local.yml` — Remove central socket-proxy service (the agent stack has its own now)
- `docker-compose.agent.yml` — Remove socket-proxy service. This file may no longer be needed if the agent is fully user-managed.
- Search for other compose files referencing socket-proxy

### 2.8 UI — Compose File Generation by Capability

**File to edit:** The "Add Host" UI components from Phase 1.5

The compose file generation should produce different files based on selected capabilities:
- **Docker-only:** Agent + socket-proxy + updater. No ZFS mounts, no `hlm-zfs` user.
- **ZFS-only:** Agent + updater. No socket-proxy. ZFS binary mounts + `/dev/zfs`.
- **Docker + ZFS:** Full stack — all three services + ZFS mounts.

### 2.9 Update Documentation

**Files to edit:**
- `self-hosting/README.md` — Replace SSH-based ZFS setup with agent stack instructions
- `docs/development.md` — Update local dev instructions (socket proxy in agent stack, not central)
- `README.md` — Update ZFS description from "via SSH" to agent-based
- `.env.example` — Update socket-proxy references

### 2.10 Run Tests and Typecheck

```bash
bun run typecheck
bun test
cd agent && bun run typecheck
cd agent && bun test
```

Verify 96%/99% coverage. SSH removal will drop coverage if tests aren't updated — ensure deleted test files don't count and new ZFS agent tests cover the new code.

---

## Phase 3 — TLS for Agent Communication

### 3.1 Configure OpenBao PKI Secrets Engine

This is infrastructure setup, not application code. Document the OpenBao CLI commands:

```bash
# Enable PKI secrets engine
bao secrets enable pki

# Configure internal CA
bao write pki/root/generate/internal \
  common_name="homelab-manager-ca" \
  ttl=87600h  # 10 years

# Create role for agent certs
bao write pki/roles/agent \
  allowed_domains="*.homelab.local" \
  allow_subdomains=true \
  max_ttl=720h  # 30 days
```

### 3.2 Agent TLS Support

**File to edit:** `agent/src/index.ts`

Bun's `Bun.serve()` natively supports TLS:

```typescript
Bun.serve({
  tls: {
    cert: Bun.file(process.env.TLS_CERT_PATH!),
    key: Bun.file(process.env.TLS_KEY_PATH!),
  },
  // ... existing config
});
```

Add env vars: `TLS_CERT_PATH`, `TLS_KEY_PATH`. When not set, agent runs without TLS (backwards compatible).

### 3.3 Agent Client HTTPS Support

**File to edit:** `src/lib/clients/agent-client.ts`

- Detect `https://` vs `http://` in agent URL
- Add CA certificate verification (the OpenBao CA cert needs to be available to the web server)
- Graceful fallback: if TLS handshake fails, log a warning but don't refuse connection (homelab resilience)

### 3.4 Certificate Rotation

Create a helper that periodically requests new certs from OpenBao PKI and writes them to the agent's mounted volume. This could be:
- A function in the updater sidecar (it already has access to manage the agent)
- A separate cert-renewal sidecar (may be overengineering for a homelab)

Recommend: add cert renewal to the updater sidecar since it already manages agent lifecycle.

### 3.5 Move Agent Token from Env Var to Mounted File

Update the agent to read its token from a file path (`AGENT_TOKEN_FILE`) instead of an environment variable (`AGENT_TOKEN`). Support both for backwards compatibility during migration, prefer file when both are set.

Update the compose template to use Docker secrets or a tmpfs-mounted file.

### 3.6 Run Tests and Typecheck

```bash
bun run typecheck
bun test
cd agent && bun run typecheck
cd agent && bun test
```

---

## Key Decisions (for the implementing session)

1. **All hosts have Docker.** No standalone agent binary or systemd service. The agent always runs as a Docker compose stack.
2. **Updater lives in monorepo** at `updater/` — same pattern as `agent/`.
3. **Socket proxy is retained** inside the agent stack on `internal: true` network. It is NOT removed.
4. **ZFS permissions are tiered:** Tier 1 (monitoring, default) requires only group membership. Tier 2 (snapshots, future) requires ZFS delegation. Tier 3 (datasets) is not planned.
5. **UI generates compose files.** The user copies them to their host. The UI cannot discover host-specific values (UID/GID) — it shows commands for the user to run and provides input fields.
6. **PKI for TLS** (Phase 3), not static KV cert storage. Certs are dynamically issued with TTLs.
7. **Follow CLAUDE.md rules strictly** — TailwindCSS only, `@/` imports, dynamic imports for server modules, `bun:test`, 96%/99% coverage, no `console.log` in committed code.

---

## Validation Checklist

After each phase, verify:

- [ ] `bun run typecheck` passes (root)
- [ ] `bun test` passes with 96%/99% coverage (root)
- [ ] `cd agent && bun run typecheck` passes
- [ ] `cd agent && bun test` passes with 96%/99% coverage
- [ ] No references to deleted files (`ssh-client`, `ssh-middleware`, `socket_proxy_url`)
- [ ] No `ZFS_HOST_*` env vars remaining (after Phase 2)
- [ ] No `ssh2` imports remaining (after Phase 2)
- [ ] `README.md` and `CLAUDE.md` updated if needed
