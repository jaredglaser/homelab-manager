# Move Agent Tokens from Database to OpenBao

**Date:** 2026-03-18
**Branch:** `docker-mgmt/5-hosts-worker-ui`

## Problem

Agent tokens are stored as plaintext in the `managed_hosts` table (`agent_token` column). The `agent_token_hash` column is unused — the agent validates bearer tokens against its own env var, not a DB hash. Credentials should not live in the database when a secrets manager (OpenBao) is already integrated.

## Solution

Store agent tokens in OpenBao at `secret/hosts/<hostname>/agent_token`. The worker initializes an OpenBao client at startup and reads tokens per-host. Both DB columns (`agent_token`, `agent_token_hash`) are dropped.

## Storage Convention

```
secret/hosts/<hostname>/agent_token
```

This parallels the existing `secret/stacks/<stack-name>/<key>` convention. Hostnames are already validated against `SAFE_PATH_SEGMENT_PATTERN` (`/^[a-zA-Z0-9_-]+$/`) by the OpenBao client.

## OpenBao Client Changes

The existing client hardcodes `stacks/` in its URL templates (e.g., `${url}/v1/secret/data/stacks/${stack}/${key}`). Passing `hosts/<hostname>` as the `stack` parameter would produce the wrong path (`secret/data/stacks/hosts/...`).

**Approach:** Add three new methods that hardcode `hosts/` in the URL, mirroring the existing stack methods:

- `getHostSecret(hostname, key)` → GET `/v1/secret/data/hosts/{hostname}/{key}`
- `setHostSecret(hostname, key, value)` → POST `/v1/secret/data/hosts/{hostname}/{key}`
- `deleteHostSecret(hostname, key)` → DELETE `/v1/secret/metadata/hosts/{hostname}/{key}`

These reuse the same `request()`, `parseJsonResponse()`, `throwApiError()`, and `validatePathSegment()` helpers. Existing stack methods are unchanged.

## Data Flow

### Writing (addHost server function)

```
1. generateToken() → plaintext UUID
2. Pass plaintext to agent container as AGENT_TOKEN env var (existing)
3. DB insert: name, agent_url, socket_proxy_url (no token columns)
4. OpenBao setHostSecret(hostname, 'agent_token', plaintext)
5. If OpenBao write fails, roll back: delete DB record + remove container
```

OpenBao write happens after DB insert so both can be rolled back on failure. If the DB insert itself fails, no OpenBao secret is written (no orphan).

### Reading (worker startup)

```
1. Worker checks DOCKER_MANAGEMENT_FEATURE_FLAG=true
2. Worker calls loadOpenBaoConfig() — crashes via ZodError if env vars missing
3. Worker creates OpenBaoClient, calls ensureSecretsEngine()
4. For each managed host from DB:
   a. Read token: client.getHostSecret(hostname, 'agent_token')
   b. If token is null, skip host (log warning)
   c. Create AgentStatsCollector(host, token)
```

### Deleting (removeHost server function)

```
1. Delete OpenBao secret: client.deleteHostSecret(hostname, 'agent_token')
2. Delete DB record (existing)
```

## Worker OpenBao Initialization

When `DOCKER_MANAGEMENT_FEATURE_FLAG=true`:
- Worker calls `loadOpenBaoConfig()` which validates `OPENBAO_URL` and `OPENBAO_TOKEN` via Zod — throws `ZodError` if missing, crashing the worker with a clear validation error
- Creates an `OpenBaoClient` instance
- Calls `ensureSecretsEngine()` to verify KV v2 is mounted

This matches the existing pattern where the worker crashes if Postgres is unreachable.

## Database Migration

```sql
-- Migration 012: Remove agent token columns (moved to OpenBao)
ALTER TABLE managed_hosts DROP COLUMN IF EXISTS agent_token;
ALTER TABLE managed_hosts DROP COLUMN IF EXISTS agent_token_hash;
```

## Type Changes

### ManagedHost (src/lib/database/repositories/host-repository.ts)
Remove `agent_token: string | null` and `agent_token_hash: string` from the interface. These are two separate fields on the same interface.

### CreateHostInput (src/lib/database/repositories/host-repository.ts)
Remove `agent_token: string` and `agent_token_hash: string`.

### ManagedHost (src/lib/deploy/types.ts)
Remove `agentTokenHash: string`. This is a separate interface from the one in host-repository.ts (camelCase fields, no token plaintext field).

### HostRepo inline interface (src/data/hosts.functions.tsx)
Remove `agent_token_hash` and `agent_token` from the `findById`, `findAll`, and `create` return/input types in the hand-rolled `HostRepo` interface.

### handleAddHost deps interface (src/data/hosts.functions.tsx)
Remove `hashToken` from deps. Add `storeToken: (hostname: string, token: string) => Promise<void>` for OpenBao write. Add `deleteToken: (hostname: string) => Promise<void>` for rollback.

### ManagedHostPublic (src/lib/hosts/host-utils.ts)
Delete the type alias entirely. `toHostListItem` accepts `ManagedHost` directly since there are no longer token fields to exclude.

### AgentStatsCollector (src/worker/collectors/agent-stats-collector.ts)
Add `token: string` constructor parameter. Change `this.host.agent_token` read in `collect()` to use `this.token`.

### createCollectorsForManagedHosts (src/worker/collector-factory.ts)
Add `getToken: (hostname: string) => Promise<string | null>` parameter. Call it per-host before creating collectors. Pass token to `AgentStatsCollector` constructor.

### collector.ts
Add OpenBao client initialization inside the management flag check block. Pass a `getToken` lambda that calls `client.getHostSecret(hostname, 'agent_token')` to `createCollectorsForManagedHosts`.

## Code Changes

### Removed
- `token-service.ts`: `hashToken()`, `verifyToken()` — keep only `generateToken()`
- `HostRepository.updateTokenHash()` method
- `agent_token_hash` and `agent_token` from all types, queries, and SQL

### Modified
- `OpenBaoClient`: add `getHostSecret`, `setHostSecret`, `deleteHostSecret`
- `hosts.functions.tsx`: `handleAddHost` stores token in OpenBao (via new `storeToken` dep), removes `hashToken` dep; `handleRemoveHost` deletes OpenBao secret (via new `deleteToken` dep); `HostRepo` interface drops token fields; `addHost`/`removeHost` server function wrappers wire OpenBao client
- `AgentStatsCollector`: constructor takes `token` param, `collect()` uses `this.token`
- `collector-factory.ts`: `createCollectorsForManagedHosts` takes `getToken` param, reads tokens, passes to collectors
- `collector.ts`: initializes OpenBao client when management flag on, passes `getToken` lambda
- `host-utils.ts`: delete `ManagedHostPublic`, `toHostListItem` accepts `ManagedHost` directly
- `host-repository.ts`: remove token fields from types, remove `updateTokenHash`, update `create` query and `rowToHost`
- `deploy/types.ts`: remove `agentTokenHash` from `ManagedHost`
- `docker-compose.dev.yml`: add `OPENBAO_URL` and `OPENBAO_TOKEN` env vars to worker service

## Error Handling

- **addHost**: OpenBao write happens after DB insert. If OpenBao write fails, roll back both (delete DB record + remove container). Same pattern as existing health check failure rollback.
- **removeHost**: If OpenBao delete fails, log warning but still delete DB record. The orphaned secret is harmless (token only works for the now-removed agent container).
- **Worker startup**: If OpenBao env vars missing with management flag on, crash via `loadOpenBaoConfig()` ZodError. If a specific host's token is missing from OpenBao, skip that host with a warning log (not a crash — other hosts may be fine).

## Testing

- `OpenBaoClient`: add tests for `getHostSecret`, `setHostSecret`, `deleteHostSecret` (same mock pattern as existing stack method tests)
- `handleAddHost`: update to inject `storeToken`/`deleteToken` mocks, verify OpenBao write and rollback
- `handleRemoveHost`: update to inject `deleteToken` mock, verify OpenBao delete
- `AgentStatsCollector`: update constructor calls to pass token string
- `createCollectorsForManagedHosts`: add `getToken` mock, test token reading and skip-on-null
- `token-service.test.ts`: remove `hashToken`/`verifyToken` tests
- `host-repository.test.ts`: remove token-related query assertions

## Environment Variables

No new env vars. Worker uses the same `OPENBAO_URL` and `OPENBAO_TOKEN` that the web server already uses. These are documented in `.env.example`.

## Docker Compose

Add `OPENBAO_URL` and `OPENBAO_TOKEN` env vars to the worker service in `docker-compose.dev.yml`. The OpenBao container is already present under the `management` profile and all containers share `homelab-network`.
