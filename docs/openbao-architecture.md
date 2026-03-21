# OpenBao Architecture & Security Analysis

## Overview

OpenBao (open-source Vault fork) serves as the centralized secrets backend for homelab-manager. It stores two categories of secrets:

1. **Stack secrets** — environment variables injected into Docker Compose deployments
2. **Host tokens** — bearer tokens authenticating the web server/worker to agent sidecars

All services share a single root token to authenticate with OpenBao over unencrypted HTTP.

---

## High-Level Architecture

```mermaid
graph TB
    subgraph network["Docker Compose Network"]
        subgraph consumers["OpenBao Consumers"]
            WEB["Web Server<br/>(TanStack Start)"]
            WORKER["Worker<br/>(Bun process)"]
            GIT["Git Post-Receive<br/>Hook (Bun process)"]
        end

        subgraph bao["OpenBao Server — http://openbao:8200 (no TLS)"]
            KV["KV v2 Secrets Engine"]
            STACKS["secret/stacks/&lt;stack&gt;/&lt;KEY&gt;<br/>→ env var values"]
            HOSTS["secret/hosts/&lt;host&gt;/agent_token<br/>→ bearer token (UUID)"]
            STORAGE["File backend: /openbao/data<br/>Init keys: .init-keys.json<br/>Auth: root policy only"]
            KV --- STACKS
            KV --- HOSTS
        end

        subgraph agents["Agent Sidecars"]
            A1["Agent (host-1)<br/>AGENT_TOKEN=uuid (env var)"]
            A2["Agent (host-2)<br/>AGENT_TOKEN=uuid (env var)"]
        end

        WEB -->|"OPENBAO_TOKEN (root)"| KV
        WORKER -->|"OPENBAO_TOKEN (root)"| KV
        GIT -->|"OPENBAO_TOKEN (root)"| KV

        WEB -->|"Bearer agent_token"| A1
        WEB -->|"Bearer agent_token"| A2
        WORKER -->|"Bearer agent_token"| A1
        WORKER -->|"Bearer agent_token"| A2
    end

    style bao fill:#1a1a2e,stroke:#e94560,color:#fff
    style consumers fill:#16213e,stroke:#0f3460,color:#fff
    style agents fill:#1a1a2e,stroke:#e94560,color:#fff
```

---

## Token & Secret Flows

### Flow 1: Agent Token Provisioning (addHost)

```mermaid
flowchart TD
    UI["UI: Add Host"] --> GEN["1. crypto.randomUUID()<br/>→ plaintext token"]
    GEN --> DOCKER["2. Docker API: create agent container<br/>AGENT_TOKEN=plaintext as env var ⚠️ A"]
    DOCKER --> DB["3. PostgreSQL: INSERT managed_hosts<br/>(no token column)"]
    DB --> BAO["4. OpenBao: POST secret/data/hosts/host/agent_token<br/>X-Vault-Token: dev-root-token ⚠️ B"]

    style DOCKER fill:#8b0000,stroke:#ff0000,color:#fff
    style BAO fill:#8b4513,stroke:#ffa500,color:#fff
```

### Flow 2: Worker Reads Agent Token (startup)

```mermaid
flowchart TD
    START["Worker Process Startup"] --> CONFIG["1. loadOpenBaoConfig()<br/>→ url + token from env vars"]
    CONFIG --> ENSURE["2. baoClient.ensureSecretsEngine()"]
    ENSURE --> LOOP["3. For each managed host in DB"]
    LOOP --> GET["baoClient.getHostSecret(hostname, agent_token)<br/>GET secret/data/hosts/host/agent_token<br/>X-Vault-Token: dev-root-token ⚠️ B"]
    GET --> COLLECT["new AgentStatsCollector(host, token)<br/>this.token = plaintext ⚠️ C<br/>→ Authorization: Bearer token"]

    style GET fill:#8b4513,stroke:#ffa500,color:#fff
    style COLLECT fill:#8b0000,stroke:#ff0000,color:#fff
```

### Flow 3: Deploy Pipeline (secret resolution)

```mermaid
flowchart TD
    TRIGGER["Deploy Trigger<br/>(UI or git push)"] --> EXEC["DeployPipeline.execute(request)"]
    EXEC --> EXTRACT["1. extractVariableReferences(composeContent)<br/>finds dollar-brace VAR_NAME patterns"]
    EXTRACT --> RESOLVE["2. secretResolver.resolve(stack, variables)<br/>LIST secret/metadata/stacks/stack → key names<br/>GET secret/data/stacks/stack/key × N → values<br/>X-Vault-Token: dev-root-token ⚠️ B"]
    RESOLVE --> BUILD["3. buildEnvContent(existingEnv, secrets)<br/>merges into .env string (plaintext) ⚠️ D"]
    BUILD --> TOKEN["4. tokenResolver(host)<br/>baoClient.getHostSecret(host, agent_token) ⚠️ B"]
    TOKEN --> DEPLOY["5. agentClient.deploy(compose, envContent, token)<br/>Authorization: Bearer agent_token ⚠️ E<br/>body contains .env with all secrets ⚠️ D"]

    style RESOLVE fill:#8b4513,stroke:#ffa500,color:#fff
    style BUILD fill:#8b0000,stroke:#ff0000,color:#fff
    style DEPLOY fill:#8b0000,stroke:#ff0000,color:#fff
```

### Flow 4: UI Secret Management

```mermaid
flowchart TD
    BROWSER["Browser (Settings UI)"] --> SERVER["Server Functions<br/>(createServerFn + openBaoMiddleware)<br/>All use X-Vault-Token: dev-root-token ⚠️ B"]
    SERVER --> LIST["listStackSecrets(stack)<br/>→ key names only (safe)"]
    SERVER --> GET["getStackSecret(stack, key)<br/>→ returns plaintext value ⚠️ F"]
    SERVER --> SET["setStackSecret(stack, key, value)<br/>→ writes to OpenBao"]
    SERVER --> DEL["deleteStackSecret(stack, key)<br/>→ deletes from OpenBao"]

    style GET fill:#8b4513,stroke:#ffa500,color:#fff
    style SERVER fill:#8b4513,stroke:#ffa500,color:#fff
```

---

## OpenBao Initialization Sequence

```mermaid
flowchart TD
    START["Container Start<br/>(entrypoint.sh)"] --> CHECK{"First run?<br/>.init-keys.json exists?"}

    CHECK -->|"No file (first run)"| INIT["POST /v1/sys/init<br/>secret_shares: 1, secret_threshold: 1 ⚠️ H"]
    INIT --> SAVE["Response saved to<br/>/openbao/data/.init-keys.json ⚠️ G<br/>(unseal key + root token in plaintext)"]
    SAVE --> UNSEAL1["POST /v1/sys/unseal<br/>key: unseal_key"]
    UNSEAL1 --> CREATE["POST /v1/auth/token/create-orphan ⚠️ H<br/>id: dev-root-token<br/>policies: root, no_parent: true"]

    CHECK -->|"File exists (subsequent)"| READ["Read unseal key<br/>from .init-keys.json"]
    READ --> UNSEAL2["POST /v1/sys/unseal<br/>key: unseal_key"]

    style SAVE fill:#8b0000,stroke:#ff0000,color:#fff
    style INIT fill:#8b4513,stroke:#ffa500,color:#fff
    style CREATE fill:#8b4513,stroke:#ffa500,color:#fff
```

---

## Security Findings & Risk Analysis

Each finding is tagged with the marker (e.g., `[A]`) from the flow diagrams above.

### CRITICAL

| # | Finding | Markers | Risk |
|---|---------|---------|------|
| 1 | **Root token shared across all services** | [B] | Web server, worker, and git hook all use the same `dev-root-token` with root policy. Compromise of any single process grants full OpenBao access (read/write/delete all secrets, manage auth, unseal). No blast-radius containment. |
| 2 | **No TLS on OpenBao listener** | [B] | `tls_disable = true` means all token and secret traffic is plaintext HTTP. Any process on the Docker network can sniff `X-Vault-Token` headers and secret values. ARP spoofing or container escape exposes everything. |
| 3 | **Init keys and root token stored in plaintext on disk** | [G] | `/openbao/data/.init-keys.json` contains the unseal key and original root token. Anyone with read access to the volume can unseal and authenticate. No file encryption, no key splitting. |
| 4 | **Agent tokens passed as container env vars** | [A] | `AGENT_TOKEN` is set as a Docker environment variable, visible via `docker inspect`, `/proc/1/environ`, and container orchestration APIs. Persists for the container lifetime. |

### HIGH

| # | Finding | Markers | Risk |
|---|---------|---------|------|
| 5 | **Agent tokens held in memory indefinitely** | [C] | `AgentStatsCollector` stores the plaintext token as an instance field for the worker's entire lifetime. Memory dump or debug endpoint could expose all agent tokens. |
| 6 | **Resolved secrets sent in plaintext to agent** | [D][E] | The deploy pipeline builds a `.env` string with all resolved secrets and sends it over HTTP to the agent. Network capture between web server and agent exposes every secret for that stack. |
| 7 | **No token rotation or expiry** | [A][C] | Agent tokens are static UUIDs with no TTL. Once generated, they're valid forever. Compromised token has unlimited use window. No rotation mechanism exists. |
| 8 | **Single Shamir share (1/1 threshold)** | [H] | Init uses `secret_shares:1, secret_threshold:1`, eliminating the security benefit of Shamir's Secret Sharing. One key unseals the vault. |

### MEDIUM

| # | Finding | Markers | Risk |
|---|---------|---------|------|
| 9 | **getStackSecret returns plaintext to browser** | [F] | The "reveal" UI calls a server function that returns the secret value over the wire to the browser. If the web server has XSS or the response is cached/logged, secrets leak. |
| 10 | **No audit logging** | all | OpenBao audit backend is not configured. No record of who read which secrets or when. Post-incident forensics impossible. |
| 11 | **No ACL policies** | [B] | All access uses root policy. Even if services got separate tokens, there's no policy restricting stacks/ vs hosts/ paths. The worker could modify stack secrets, the web server could delete host tokens, etc. |
| 12 | **File storage backend** | [G] | File backend provides no encryption at rest, no HA, and no replication. Disk access = full secret access. Production should use integrated storage (Raft). |

---

## Recommended Mitigations (Priority Order)

### Phase 1 — Network & Transport

1. **Enable TLS on OpenBao listener** — Generate certs (self-signed or internal CA) and set `tls_cert_file` / `tls_key_file`. All clients switch to HTTPS.
2. **Enable TLS for agent communication** — Agent sidecar should accept HTTPS connections; deploy pipeline and worker should verify certificates.

### Phase 2 — Authentication & Authorization

3. **Create per-service AppRole credentials** — Replace the shared root token with three AppRole logins:
   - `web-server` — read/write `secret/stacks/*`, read `secret/hosts/*/agent_token`
   - `worker` — read `secret/hosts/*/agent_token` only
   - `git-hook` — read `secret/stacks/*`, read `secret/hosts/*/agent_token`
4. **Scope policies with path restrictions** — Deny `sys/*` to all non-admin roles.
5. **Revoke the root token after setup** — Use `bao token revoke` post-init.

### Phase 3 — Token Lifecycle

6. **Implement agent token rotation** — Periodic re-generation with coordinated agent restart.
7. **Use short-lived tokens** — AppRole tokens with TTL + periodic renewal.
8. **Move agent tokens from env vars to mounted secrets** — Use Docker secrets or tmpfs-mounted files instead of environment variables.

### Phase 4 — Operational Security

9. **Enable audit logging** — `bao audit enable file file_path=/openbao/logs/audit.log` to capture all secret access.
10. **Increase Shamir shares** — Use at least 3 shares with threshold 2 for production.
11. **Encrypt init keys at rest** — Don't store `.init-keys.json` on the same volume as OpenBao data.
12. **Switch to Raft storage** — For encryption at rest, HA, and snapshot support.

---

## Secret Path Layout

```mermaid
graph LR
    ROOT["secret/"] --> STACKS["stacks/"]
    ROOT --> HOSTS["hosts/"]

    STACKS --> PLEX["plex/"]
    PLEX --> PLEX_DB["DB_PASSWORD"]
    PLEX --> PLEX_API["API_KEY"]

    STACKS --> NC["nextcloud/"]
    NC --> NC_ADMIN["ADMIN_PASSWORD"]

    HOSTS --> H1["docker-host-1/"]
    H1 --> H1_TOKEN["agent_token (UUID)"]

    HOSTS --> H2["docker-host-2/"]
    H2 --> H2_TOKEN["agent_token (UUID)"]

    style PLEX_DB fill:#2d572c,stroke:#5cb85c,color:#fff
    style PLEX_API fill:#2d572c,stroke:#5cb85c,color:#fff
    style NC_ADMIN fill:#2d572c,stroke:#5cb85c,color:#fff
    style H1_TOKEN fill:#8b4513,stroke:#ffa500,color:#fff
    style H2_TOKEN fill:#8b4513,stroke:#ffa500,color:#fff
```

---

## Component Credential Matrix

| Component | Credentials Held | How Obtained | Lifetime |
|-----------|-----------------|--------------|----------|
| Web Server | `OPENBAO_TOKEN` (root) | Environment variable | Process lifetime |
| Worker | `OPENBAO_TOKEN` (root), agent tokens (in memory) | Env var + OpenBao GET | Process lifetime |
| Git Hook | `OPENBAO_TOKEN` (root) | Environment variable | Per-invocation |
| Agent | `AGENT_TOKEN` (UUID) | Container env var | Container lifetime |
| OpenBao | Unseal key, root token | `.init-keys.json` on disk | Until revoked (never) |
| Deploy Pipeline | Stack secrets (in transit), agent token (in transit) | OpenBao GET → HTTP POST to agent | Request-scoped |
| Browser | Individual secret values (on reveal) | Server function response | Until page navigation |

---

## Target Architecture — Direct Agent (No Socket Proxy)

### Motivation

The current architecture uses a Docker socket proxy between the agent and the Docker daemon. With the agent serving as the sole entry point for all Docker operations, the socket proxy is redundant — the agent already enforces API restrictions through its explicit route definitions (only `deploy`, `teardown`, `restart`, `stats`, `logs`, `health`, `events`). Removing the socket proxy simplifies the stack, reduces the attack surface to a single authenticated endpoint, and makes TLS viable end-to-end.

### Current vs Target

```
CURRENT:
  Web Server ──HTTP──▶ Agent ──HTTP──▶ Socket Proxy ──▶ Docker Socket
  Worker ────HTTP──▶ Agent ──HTTP──▶ Socket Proxy ──▶ Docker Socket

TARGET:
  Web Server ──TLS──▶ Agent ──▶ Docker Socket (mounted)
  Worker ────TLS──▶ Agent ──▶ Docker Socket (mounted)
```

### Target High-Level Architecture

```mermaid
graph TB
    subgraph homelab["homelab-manager (central)"]
        subgraph consumers["Services"]
            WEB["Web Server<br/>(TanStack Start)"]
            WORKER["Worker<br/>(Bun process)"]
            GIT["Git Post-Receive<br/>Hook"]
        end

        subgraph bao["OpenBao Server — https://openbao:8200 (TLS)"]
            KV["KV v2 Secrets Engine"]
            STACKS_S["secret/stacks/…<br/>→ env var values"]
            HOSTS_S["secret/hosts/…<br/>→ agent_token"]
            PKI["PKI Secrets Engine<br/>→ agent TLS certs"]
            KV --- STACKS_S
            KV --- HOSTS_S
            KV --- PKI
        end

        DB["TimescaleDB"]

        WEB -->|"AppRole token"| KV
        WORKER -->|"AppRole token"| KV
        GIT -->|"AppRole token"| KV
    end

    subgraph host1["Remote Docker Host 1"]
        A1["Agent<br/>/var/run/docker.sock mounted<br/>TLS + Bearer token"]
        D1["Docker Daemon"]
        A1 -->|"unix socket"| D1
    end

    subgraph host2["Remote Docker Host 2"]
        A2["Agent<br/>/var/run/docker.sock mounted<br/>TLS + Bearer token"]
        D2["Docker Daemon"]
        A2 -->|"unix socket"| D2
    end

    WEB -->|"TLS + Bearer"| A1
    WEB -->|"TLS + Bearer"| A2
    WORKER -->|"TLS + Bearer"| A1
    WORKER -->|"TLS + Bearer"| A2
    WORKER -->|"INSERT stats"| DB

    style bao fill:#1a1a2e,stroke:#e94560,color:#fff
    style consumers fill:#16213e,stroke:#0f3460,color:#fff
    style host1 fill:#1a1a2e,stroke:#0f3460,color:#fff
    style host2 fill:#1a1a2e,stroke:#0f3460,color:#fff
```

### Key Changes

| Aspect | Current | Target |
|--------|---------|--------|
| Docker access | Agent → socket proxy (TCP) → Docker socket | Agent → Docker socket (mounted) |
| Transport | Plaintext HTTP | TLS (certs from OpenBao PKI) |
| Auth | Bearer token only | TLS mutual auth + Bearer token |
| Socket proxy | Required per host | **Removed** |
| Agent deployment | Via socket proxy Dockerode | SSH bootstrap or user one-liner |

---

## Agent Deployment Flow

The agent must be running on each Docker host before homelab-manager can manage it. Two deployment paths are supported: **automatic deployment** (homelab-manager deploys via SSH) and **manual deployment** (user runs a one-liner).

### Flow: Add Host

```mermaid
flowchart TD
    UI["UI: Add Host<br/>(hostname, SSH creds or agent URL)"] --> MODE{Deployment mode?}

    MODE -->|"Auto-deploy<br/>(SSH credentials provided)"| SSH_DEPLOY
    MODE -->|"Manual / Existing<br/>(agent URL provided)"| REGISTER

    subgraph SSH_DEPLOY["Auto-Deploy via SSH"]
        GEN_TOKEN["1. Generate agent token<br/>crypto.randomUUID()"]
        SSH_CHECK["2. SSH to host<br/>Check if agent container exists"]
        SSH_CHECK --> EXISTS{Agent running?}
        EXISTS -->|"Yes"| RECONFIG["3a. Reconfigure existing agent<br/>(update token, restart)"]
        EXISTS -->|"No"| DEPLOY["3b. docker run<br/>ghcr.io/…/homelab-agent<br/>-v /var/run/docker.sock<br/>-e AGENT_TOKEN=…"]
        RECONFIG --> HEALTH_SSH["4. Health check agent"]
        DEPLOY --> HEALTH_SSH
    end

    subgraph REGISTER["Register Existing Agent"]
        HEALTH_REG["1. Health check provided URL"]
        HEALTH_REG --> REG_OK{Healthy?}
        REG_OK -->|"Yes"| STORE_REG["2. Store token in OpenBao<br/>+ create DB record"]
        REG_OK -->|"No"| FAIL_REG["Error: agent not reachable"]
    end

    HEALTH_SSH --> STORE["5. Store token in OpenBao"]
    STORE --> DB_REC["6. INSERT managed_hosts"]
    DB_REC --> DONE["Host ready ✓"]

    STORE_REG --> DONE

    style SSH_DEPLOY fill:#16213e,stroke:#0f3460,color:#fff
    style REGISTER fill:#16213e,stroke:#0f3460,color:#fff
```

### Manual One-Liner

For users who prefer to deploy the agent themselves (or for hosts without SSH access), provide a copy-pasteable command:

```bash
docker run -d \
  --name homelab-agent \
  --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v homelab-stacks:/opt/homelab-manager/stacks \
  -p 9090:9090 \
  -e AGENT_TOKEN=<generated-token> \
  ghcr.io/your-org/homelab-agent:latest
```

The UI generates the token, displays the one-liner with the token pre-filled, and waits for the user to confirm. Then it health-checks the agent URL and registers the host.

### Auto-Deploy via SSH

When SSH credentials are provided (password or key), homelab-manager connects to the remote host and:

1. **Checks** if a `homelab-agent` container already exists (`docker inspect homelab-agent`)
2. **If exists**: stops, removes, and re-creates with new config
3. **If not**: pulls the image and runs the container
4. **Health checks** the agent on `http://<host>:<port>/health`
5. **Stores** the token in OpenBao and creates the DB record

```mermaid
flowchart TD
    START["SSH connect to host"] --> INSPECT["docker inspect homelab-agent"]
    INSPECT --> EXISTS{Container exists?}

    EXISTS -->|"Not found (404)"| PULL["docker pull ghcr.io/…/homelab-agent:latest"]
    PULL --> RUN["docker run -d<br/>--name homelab-agent<br/>-v /var/run/docker.sock:/var/run/docker.sock<br/>-v homelab-stacks:/opt/homelab-manager/stacks<br/>-p 9090:9090<br/>-e AGENT_TOKEN=token"]
    RUN --> HEALTH["Health check<br/>GET http://host:9090/health"]

    EXISTS -->|"Found"| RUNNING{Running?}
    RUNNING -->|"Yes"| STOP["docker stop homelab-agent"]
    RUNNING -->|"No"| RM["docker rm homelab-agent"]
    STOP --> RM
    RM --> PULL

    HEALTH --> OK{Healthy?}
    OK -->|"Yes"| DONE["Return agent URL + version"]
    OK -->|"No"| RETRY["Retry with backoff<br/>(500ms, 1s, 2s)"]
    RETRY --> HEALTH
```

### Agent Container Changes

The agent Dockerfile and docker-compose are updated:

| Change | Before | After |
|--------|--------|-------|
| Docker access | `DOCKER_HOST=tcp://socket-proxy:2375` | `/var/run/docker.sock` mounted |
| `depends_on` | `socket-proxy` | *(none)* |
| Compose services | `socket-proxy` + `agent` | `agent` only |
| User permissions | `agent` user (non-root) | `agent` user added to `docker` group (or socket bind-mounted with correct GID) |

### Database Schema Changes

The `managed_hosts` table drops `socket_proxy_url` (no longer needed) and adds SSH connection fields for auto-deploy:

```sql
ALTER TABLE managed_hosts
  DROP COLUMN socket_proxy_url,
  ADD COLUMN ssh_host TEXT,          -- hostname/IP for SSH (nullable — not needed for manual deploy)
  ADD COLUMN ssh_port INTEGER DEFAULT 22,
  ADD COLUMN ssh_user TEXT,
  ADD COLUMN deployment_method TEXT NOT NULL DEFAULT 'manual';  -- 'manual' | 'ssh'
  -- SSH credentials (password or key) stored in OpenBao at secret/hosts/<name>/ssh_password or ssh_key
```

### OpenBao Secret Path Updates

```mermaid
graph LR
    ROOT["secret/"] --> STACKS["stacks/"]
    ROOT --> HOSTS["hosts/"]

    HOSTS --> H1["docker-host-1/"]
    H1 --> H1_TOKEN["agent_token"]
    H1 --> H1_SSH["ssh_password<br/>(or ssh_key)"]
    H1 --> H1_TLS["tls_cert<br/>tls_key"]

    HOSTS --> H2["docker-host-2/"]
    H2 --> H2_TOKEN["agent_token"]
    H2 --> H2_TLS["tls_cert<br/>tls_key"]

    style H1_TOKEN fill:#8b4513,stroke:#ffa500,color:#fff
    style H2_TOKEN fill:#8b4513,stroke:#ffa500,color:#fff
    style H1_SSH fill:#2d572c,stroke:#5cb85c,color:#fff
    style H1_TLS fill:#16213e,stroke:#0f3460,color:#fff
    style H2_TLS fill:#16213e,stroke:#0f3460,color:#fff
```

---

## Implementation Phases

### Phase 0 — Remove Socket Proxy (this PR)

Architecture diagrams and documentation updated to reflect the target state. No code changes yet.

### Phase 1 — Agent Direct Socket Access

1. Mount `/var/run/docker.sock` in agent container instead of `DOCKER_HOST=tcp://socket-proxy:2375`
2. Update agent Dockerfile to handle socket permissions (GID matching)
3. Remove socket-proxy service from docker-compose files
4. Update `AgentProvisioningService` to provision without socket proxy
5. Drop `socket_proxy_url` from `managed_hosts` schema and all referencing code

### Phase 2 — Agent Auto-Deploy via SSH

1. Add SSH connection fields to `managed_hosts` table
2. Create `AgentSSHDeployService` — SSH to host, check/deploy agent container
3. Store SSH credentials in OpenBao at `secret/hosts/<name>/ssh_password` or `ssh_key`
4. Update `handleAddHost` to support both SSH auto-deploy and manual registration
5. UI: add deployment method selector (SSH auto-deploy vs manual one-liner)
6. UI: generate and display one-liner with pre-filled token for manual path

### Phase 3 — TLS for Agent Communication

1. Configure OpenBao PKI secrets engine as internal CA
2. Agent reads TLS cert/key from mounted files or OpenBao
3. Update `AgentClient` to use HTTPS with certificate verification
4. Update agent to serve HTTPS (Bun native TLS support)
5. Rotate certs automatically via OpenBao PKI TTL
