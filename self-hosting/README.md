# Self-Hosting homelab-manager

A real-time monitoring dashboard for Docker containers, ZFS pools, and Proxmox VE clusters.

> [!WARNING]
> **Stack management and agent functionality are currently unstable and under active development.** Expect breaking changes, incomplete features, and rough edges. Use at your own risk.

> [!WARNING]
> **Do not expose this dashboard to the public internet.** The dashboard ships with built-in OIDC authentication (on by default), but the service is not hardened for untrusted networks. Keep it on your LAN, and ideally isolate it further with a dedicated lab VLAN or a firewall rule that restricts access to specific hosts.
>
> For remote access, use a VPN tunnel back to your home network rather than port-forwarding. [Tailscale](https://tailscale.com) and [WireGuard](https://www.wireguard.com) are both solid options: install the client on your phone or laptop, connect to your homelab's VPN, and access the dashboard at its local IP as if you were home.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) 24+
- [Docker Compose](https://docs.docker.com/compose/install/) v2.20+

## Quick Start

**1. Download the compose file**

```bash
curl -O https://raw.githubusercontent.com/jaredglaser/homelab-manager/main/self-hosting/docker-compose.yml
```

**2. Create a `.env` file**

Copy the base template below into a `.env` file in the same directory and fill in your values:

```env
# PostgreSQL
POSTGRES_DB=homelab
POSTGRES_USER=homelab
POSTGRES_PASSWORD=changeme   # change this

# Master encryption key for stack secrets and per-agent keypairs
# Generate with: openssl rand -base64 32
MASTER_KEY=changeme          # replace with a generated key
```

**3. Choose an authentication path**

Authentication is on by default and must be configured before the dashboard is usable. Pick one:

**Path A: OIDC login (recommended).** Set up an OIDC provider and add its values to `.env`:

```env
OIDC_ISSUER_URL=https://id.example.com
OIDC_CLIENT_ID=homelab-manager
OIDC_CLIENT_SECRET=your-client-secret
OIDC_REDIRECT_URI=http://<your-server-ip>:3000/api/auth/callback
```

The dashboard is designed and tested with [Pocket ID](https://github.com/pocket-id/pocket-id), a lightweight OIDC/passkey provider built for homelabs, but works with any OIDC issuer. Follow the [Pocket ID setup walkthrough](#setting-up-pocket-id) below before your first login; skipping the group setup locks you out at a "denied" page.

**Path B: no login, trusted network only.** Explicitly opt out of authentication:

```env
AUTH_DISABLED=true
```

With auth disabled, anyone who can reach the port can view your infrastructure and change settings. Only use this on an isolated network you trust (see the warning above).

**4. Start**

```bash
docker compose up -d
```

Open `http://<your-server-ip>:3000` (or whichever port you set via `WEB_PORT`). The worker applies database migrations on its first start, so give the stack a few seconds before the first page load.

**5. Stop**

```bash
docker compose down
```

Data is persisted in Docker volumes (`pgdata`, `git-repos`) and survives restarts. To wipe everything:

```bash
docker compose down -v
```

---

## Services

| Service | Image | Description |
|---------|-------|-------------|
| `postgres` | `timescale/timescaledb:latest-pg16` | Time-series database (infinite retention, automatic compression after 7 days). Runs with `synchronous_commit=off` - up to ~200ms of stats can be lost on a hard crash, which is acceptable for monitoring data where transaction latency matters more than durability. |
| `worker` | `ghcr.io/jaredglaser/homelab-manager-worker` | Background collector - connects to agent sidecars (Docker/ZFS) and polls Proxmox, writes stats to TimescaleDB. Also applies database migrations on startup. |
| `web` | `ghcr.io/jaredglaser/homelab-manager-web` | Dashboard UI and API server. Streams stats from TimescaleDB to connected clients via SSE. |

Two more images run on **monitored hosts** (not in this compose file). The Add Host wizard generates a compose stack for them during enrollment:

| Image | Description |
|-------|-------------|
| `ghcr.io/jaredglaser/homelab-manager-agent` | Agent sidecar deployed on each monitored Docker/ZFS host |
| `ghcr.io/jaredglaser/homelab-manager-agent-updater` | Optional companion that keeps the agent image up to date |

> **Note:** Images are published to GitHub Container Registry ([web](https://github.com/jaredglaser/homelab-manager/pkgs/container/homelab-manager-web), [worker](https://github.com/jaredglaser/homelab-manager/pkgs/container/homelab-manager-worker), [agent](https://github.com/jaredglaser/homelab-manager/pkgs/container/homelab-manager-agent), [agent-updater](https://github.com/jaredglaser/homelab-manager/pkgs/container/homelab-manager-agent-updater)) on every push to `main`. The project is pre-release and not yet versioned: use `latest`, and review recent commits on `main` for breaking changes before pulling updates.

---

## Configuration

All configuration is done via environment variables in your `.env` file. The compose file forwards each documented variable to the container that reads it; if you add variables beyond the ones listed here (for example an extra `MASTER_KEY_<KID>` during key rotation), you must also add them to the matching service's `environment:` block, because Compose does not pass arbitrary `.env` keys through on its own.

### Required

| Variable | Description |
|----------|-------------|
| `POSTGRES_DB` | Database name |
| `POSTGRES_USER` | Database user |
| `POSTGRES_PASSWORD` | Database password |
| `MASTER_KEY` or `MASTER_KEY_FILE` | Base64-encoded 256-bit key for at-rest encryption of stack secrets, agent keypairs, and git tokens. Set exactly one. Generate with `openssl rand -base64 32`. `MASTER_KEY_FILE` points at a file *inside the container*, so it also requires adding a matching volume mount to the `worker` and `web` services in the compose file. See [Master Key Rotation](#master-key-rotation) and [Backup and Restore](#backup-and-restore) before you rely on it: losing this key permanently orphans everything encrypted with it. |

### Web Server

| Variable | Default | Description |
|----------|---------|-------------|
| `WEB_PORT` | `3000` | Host port for the dashboard |

### Authentication (OIDC)

On by default. Configure an OIDC provider (designed and tested with [Pocket ID](https://github.com/pocket-id/pocket-id), but works with any OIDC issuer), or set `AUTH_DISABLED=true` to opt out on a trusted network. The opt-out is deliberate: an unrecognized `AUTH_DISABLED` value or the removed legacy `AUTH_ENABLED` variable fails startup instead of silently opening the app. With auth disabled, every request runs as a synthetic admin and the dashboard relies on network isolation (see the warning above).

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_DISABLED` | unset (auth required) | Set to `true` (or `1`/`yes`/`on`) to disable OIDC login for all routes and SSE streams |
| `OIDC_ISSUER_URL` | - | OIDC issuer URL, used for discovery (e.g. `https://id.example.com`) |
| `OIDC_CLIENT_ID` | - | OIDC client ID registered with your provider |
| `OIDC_CLIENT_SECRET` | - | OIDC client secret. Not validated at startup; a missing or wrong secret surfaces as a failed login attempt, so test a login after changing it. |
| `OIDC_REDIRECT_URI` | - | Callback URL pointing at **this dashboard**, always ending in `/api/auth/callback` (e.g. `https://homelab.example.com/api/auth/callback`). This is not a URL on your OIDC provider. It must exactly match the callback URL registered in the provider. |
| `SESSION_TTL_HOURS` | `8` | Session cookie lifetime |
| `OIDC_ROLE_ADMIN` | `homelab-admins` | OIDC group claim that maps to the `admin` role |
| `OIDC_ROLE_OPERATOR` | `homelab-operators` | OIDC group claim that maps to the `operator` role |
| `OIDC_ROLE_VIEWER` | `homelab-viewers` | OIDC group claim that maps to the `viewer` role |

Roles come from the provider's `groups` claim (the app requests the `openid profile email groups` scopes and reads groups from both the userinfo endpoint and the ID token). A user whose groups match none of the three role mappings is denied access entirely. There is no bootstrap admin: get the group membership right in the provider before the first login.

#### Setting up Pocket ID

Step-by-step for a working login with [Pocket ID](https://github.com/pocket-id/pocket-id). The same shape applies to other providers.

1. **Create the role groups.** In the Pocket ID admin UI, create user groups matching your role mapping (by default `homelab-admins`, `homelab-operators`, `homelab-viewers`; only the ones you need). Assign your user to the right group, e.g. `homelab-admins` for the admin role.
2. **Create an OIDC client** for the dashboard. Set its callback URL to your dashboard's callback: `http(s)://<dashboard-host>/api/auth/callback`. This exact value also goes into `OIDC_REDIRECT_URI`. A common mistake is pointing `OIDC_REDIRECT_URI` at the provider (e.g. an `/authorize` URL); it must point at the dashboard.
3. **Allow your group on the client.** Pocket ID can restrict which user groups may use a client (new clients are restricted by default on recent versions). If your user's group is not allowed on the client, Pocket ID blocks the login with "You're not allowed to access this service." before the dashboard is ever involved. This client-access setting is separate from the role-mapping groups in step 1, even if you use the same group for both.
4. **Copy the client ID and secret** into `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`.
5. Set `OIDC_ISSUER_URL` to your Pocket ID base URL (e.g. `https://id.example.com`), then `docker compose up -d` and log in.

If login succeeds at the provider but the dashboard shows "You don't have access to this application", the OIDC handshake worked and the role mapping failed: your user's groups matched none of the `OIDC_ROLE_*` values. Fix the group membership in Pocket ID and log in again.

### Reverse Proxy

Any reverse proxy works. [Caddy](https://caddyserver.com/docs/) is a popular homelab choice - refer to its docs for setup. Three dashboard-specific requirements:

- **Serve over HTTPS if you can.** The session cookie is only marked `Secure` when `OIDC_REDIRECT_URI` starts with `https://`, so an https reverse proxy plus an https redirect URI keeps the session cookie off plaintext connections.
- **Do not buffer SSE.** All real-time updates stream over long-lived `text/event-stream` responses under `/api/`. Disable response buffering for those routes (nginx: `proxy_buffering off;`) and raise the read/idle timeout well above its 60s default, or the dashboard will appear frozen or lose live updates.
- **Forward client IPs.** The dashboard records `X-Forwarded-For` on login sessions for auditing, so pass it through.

**Keep the dashboard on your LAN.** A reverse proxy does not change the security posture described in the warning above. Do not route this dashboard through a public-facing proxy.

### Agent Environment

These variables are set on each **agent** container (not on the dashboard or worker). The Add Host wizard (**Settings → Managed Hosts → Add Host**) generates a ready-to-use compose stack for the agent, including a Docker socket proxy, the agent-updater, and any ZFS device/binary mounts, so you normally never write this by hand. The variables below are for reference when customizing the generated stack.

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_HOST_NAME` | - | **Required.** Must equal the managed host's name as registered in **Settings → Managed Hosts**. Manager-issued JWTs carry this name as the `aud` claim, so a token minted for one host is rejected by another (protects against a reused or copy-pasted keypair). The agent exits at startup if it is unset. |
| `AGENT_TRUSTED_PUBKEY` or `AGENT_TRUSTED_PUBKEY_FILE` | - | Trusted Ed25519 public JWK the agent verifies request JWTs against. The dashboard hands you this value during the Verify step. Set one of the two; if both are set, the `_FILE` variant wins. |
| `AGENT_PORT` | `9090` | Port the agent listens on |
| `DOCKER_HOST` | - | Docker endpoint (socket proxy recommended, e.g. `tcp://socket-proxy:2375`). Enables the Docker capability. |
| `TLS_CERT_PATH` / `TLS_KEY_PATH` | - | Optional TLS for the agent's listener. Set both together. |

### Docker Monitoring

Docker monitoring works through agent sidecars. Deploy the agent container on each host you want to monitor, then register the host in **Settings → Managed Hosts** with the `docker` capability enabled. The worker subscribes to the agent's SSE streams for stats and container inventory; no direct Docker socket access is required on the dashboard host.

> **Setup:** See the [Docker Stack Management](#docker-stack-management) section below for the agent deploy flow. The same agent serves both monitoring and deploy operations.

### ZFS Monitoring

ZFS monitoring works through agent sidecars (the same agents used for Docker management). When you register a managed host with ZFS capability, the worker connects to the agent's `/zfs/stats/stream` SSE endpoint to receive real-time `zpool iostat` data. No SSH configuration is needed.

The agent image does not ship ZFS tooling; the ZFS capability requires bind-mounting the host's binaries and device node into the agent container (`/usr/sbin/zpool` and `/usr/sbin/zfs` read-only, plus `/dev/zfs`), and running the container as a uid/gid with permission on `/dev/zfs`. The Add Host wizard generates all of this when you enable the ZFS capability; if you hand-write the agent compose file and omit the mounts, the agent logs "ZFS capability: disabled" at startup because it cannot find the `zpool` binary.

> **Setup:** Deploy the wizard-generated agent stack on a host with ZFS pools, then register the host in **Settings → Managed Hosts** with the `zfs` capability enabled.

### Proxmox VE Monitoring

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXMOX_HOST` | - | Proxmox VE hostname or IP |
| `PROXMOX_PORT` | `8006` | Proxmox API port |
| `PROXMOX_TOKEN_ID` | - | API token ID (`USER@REALM!TOKENID`) |
| `PROXMOX_TOKEN_SECRET` | - | API token secret (UUID) |
| `PROXMOX_ALLOW_SELF_SIGNED` | `true` | Allow self-signed TLS certificates |

> **Proxmox API token:** Create one via **Datacenter > Permissions > API Tokens**. The token needs `PVEAuditor` role (read-only) on `/` for cluster overview data.

### Docker Stack Management

Stack management lets you deploy and manage Docker Compose stacks on your hosts via the dashboard, either from the UI or by pushing to the built-in git repository at `/api/git/stacks`. Full repo, token, and manifest reference: [Git Stacks Repository](../docs/git-stacks-repo.md).

Two separate credentials are involved, neither of which is an env var:

- **Dashboard-to-agent:** each deploy request carries a short-lived JWT signed by a per-host Ed25519 keypair stored encrypted in the database; no token file is distributed to hosts.
- **Git pushes:** authenticated with per-user git tokens. Generate one in **Settings → Auth Management → Generate Git Token** (admin only; the token is shown once). Use it as the password on `git push`; pushes require the `admin` or `operator` role.

> **How it works:** Each managed Docker host runs a lightweight agent container that the dashboard communicates with for deploy operations. When you enroll a host, the dashboard generates an Ed25519 keypair, encrypts the private key with `MASTER_KEY`, and sends the public JWK to the agent. Each deploy request carries a short-lived signed JWT; the agent verifies it against the trusted public key.
>
> **Adding a host:** Use **Settings → Managed Hosts → Add Host** in the dashboard. The wizard generates a compose stack for the agent and handles key exchange during the Verify step. Set `AGENT_HOST_NAME` on the agent to the host name you enter in the wizard (see [Agent Environment](#agent-environment)). Once connectivity is confirmed, the keypair is stored and the host is ready.

### PostgreSQL Connection

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_SSL` | `false` | Enable TLS for the PostgreSQL connection |
| `POSTGRES_SSL_REJECT_UNAUTHORIZED` | `true` | Verify the server's TLS certificate. Set to `false` only for self-signed certificates. This disables chain validation and exposes the connection to MITM attacks. |
| `POSTGRES_POOL_SIZE` | `10` | Database connection pool size |

### Deploy Watchdog (optional)

Runs inside the web container; scans for deploys stuck `in_progress` (e.g. after a crash) and fails them.

| Variable | Default | Description |
|----------|---------|-------------|
| `DEPLOY_WATCHDOG_INTERVAL_MS` | `120000` | How often to scan for stuck deploys |
| `DEPLOY_WATCHDOG_TIMEOUT_MINUTES` | `20` | Deploys still `in_progress` past this threshold are failed |

### Worker Behavior

The worker always runs and applies database migrations on startup; individual collection sources are toggled per source.

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_DOCKER_ENABLED` | `true` | Enable Docker stats collection |
| `WORKER_ZFS_ENABLED` | `false` | Enable ZFS stats collection |
| `WORKER_PROXMOX_ENABLED` | `false` | Enable Proxmox stats collection |
| `WORKER_COLLECTION_INTERVAL_MS` | `1000` | Collection interval in milliseconds |
| `WORKER_LOCALHOST_AGENT` | - | Docker-internal hostname to substitute for `localhost` agent URLs (e.g. `hlm-agent`). Set this when the worker and an agent container run on the same Docker host; without it, `localhost` agent URLs resolve to the worker container itself rather than the agent container. |

---

## Master Key Rotation

Encrypted columns use a versioned keyring so a new master key can be enrolled without breaking existing ciphertext. `MASTER_KEY` is treated as key ID `v1`; additional keys use `MASTER_KEY_<KID>` (e.g. `MASTER_KEY_v2`). The highest-ranked KID encrypts new secrets (`vN` KIDs compare numerically, so `v10` outranks `v9`); all loaded keys decrypt.

1. Generate a new key: `openssl rand -base64 32`
2. Add `MASTER_KEY_v2=<new-base64>` to `.env` (keep the old `MASTER_KEY` in place), **and** add `MASTER_KEY_v2: ${MASTER_KEY_v2:-}` to the `environment:` blocks of both the `web` and `worker` services in `docker-compose.yml`. Compose only forwards variables that the service block names.
3. Recreate the containers: `docker compose up -d`
4. Re-encrypt existing rows inside the web container:

   ```bash
   docker compose exec web bun run migrate-secrets --from v1 --to v2
   ```

5. Remove the old key from `.env` (and its compose line if you added one), then `docker compose up -d` again.

The migration exits non-zero on any failure. Partially migrated rows are safe because both keys stay in the keyring during the rotation window. It covers `stack_secrets`, `agent_keypairs`, and `git_tokens`; active login sessions are not re-encrypted, so a login that predates the rotation may need to sign in again after step 5 removes the old key.

## Backup and Restore

Three things constitute a full backup:

1. **The database.** Either snapshot the `pgdata` volume while the stack is stopped, or take a live dump: `docker compose exec postgres pg_dump -U $POSTGRES_USER -Fc $POSTGRES_DB > homelab.dump`
2. **The git repos volume** (`git-repos`), which holds your stack definitions.
3. **Your `.env`, especially `MASTER_KEY`.**

The master key is not stored in the database. A database backup without the key is incomplete: stack secrets, every managed host's agent keypair, and all git tokens are encrypted with it and cannot be recovered if it is lost. You would have to re-enter all stack secrets, re-enroll every managed host, and regenerate git tokens. Store the key somewhere safe and separate from the database backup.

## Health Monitoring

The web service exposes an unauthenticated `GET /api/health` endpoint that verifies database reachability: `200 {"status":"ok","database":true}` when healthy, `503` otherwise. The compose file uses it for the `web` service's Docker healthcheck, and it is the right target for an external uptime monitor (e.g. Uptime Kuma):

```bash
curl http://<your-server-ip>:3000/api/health
```

---

## Full `.env` Example

```env
# PostgreSQL
POSTGRES_DB=homelab
POSTGRES_USER=homelab
POSTGRES_PASSWORD=a-strong-password-here

# Master encryption key (generate with: openssl rand -base64 32)
MASTER_KEY=a-long-base64-string-here

# Web Server
# WEB_PORT=3000

# Authentication: pick ONE path.
# Path A: OIDC login (recommended; see the Pocket ID walkthrough)
OIDC_ISSUER_URL=https://id.example.com
OIDC_CLIENT_ID=homelab-manager
OIDC_CLIENT_SECRET=your-client-secret
OIDC_REDIRECT_URI=https://homelab.example.com/api/auth/callback
# SESSION_TTL_HOURS=8
# OIDC_ROLE_ADMIN=homelab-admins
# OIDC_ROLE_OPERATOR=homelab-operators
# OIDC_ROLE_VIEWER=homelab-viewers
# Path B: no login, trusted network only (comment out the OIDC block above)
# AUTH_DISABLED=true

# Docker: no env vars needed; register hosts with the Docker capability
# in Settings → Managed Hosts after deploying an agent sidecar.

# ZFS: no worker env vars needed; deploy the wizard-generated agent stack
# (includes the required zpool/zfs/dev mounts) and register the host with
# the ZFS capability in Settings → Managed Hosts.

# Proxmox VE
PROXMOX_HOST=192.168.1.100
PROXMOX_TOKEN_ID=root@pam!monitoring
PROXMOX_TOKEN_SECRET=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# Worker
# WORKER_DOCKER_ENABLED=true
# WORKER_ZFS_ENABLED=false
WORKER_PROXMOX_ENABLED=true
# WORKER_COLLECTION_INTERVAL_MS=1000
# WORKER_LOCALHOST_AGENT=hlm-agent
```

---

## Updating

Pull the latest images and recreate containers:

```bash
docker compose pull
docker compose up -d
```

The worker applies any pending database migrations when it starts, so it must come up as part of every update. There is no downgrade path: back up before updating (see [Backup and Restore](#backup-and-restore)).

## Troubleshooting

**Login always fails with `error=login_failed` in the URL**
- The web container cannot complete the OIDC flow. Check `docker compose logs web` for the reason: usually missing `OIDC_*` variables, an unreachable `OIDC_ISSUER_URL`, or a wrong `OIDC_CLIENT_SECRET` (the secret is only validated at login time, not startup).

**Provider says "You're not allowed to access this service" (Pocket ID)**
- Your user's group is not allowed on the OIDC client in Pocket ID. Grant the group access on the client itself (or unrestrict the client). See step 3 of the [Pocket ID walkthrough](#setting-up-pocket-id).

**Dashboard says "You don't have access to this application"**
- The OIDC login worked, but none of your user's groups match `OIDC_ROLE_ADMIN`/`OPERATOR`/`VIEWER`. Fix the group membership in the provider (and confirm the provider includes a `groups` claim), then log in again.

**Dashboard shows no data**
- Check the worker logs: `docker compose logs -f worker`
- Verify your Docker/ZFS/Proxmox host is reachable from the container: `docker compose exec worker ping <host>`

**Database connection errors**
- The web and worker services wait for the database to be healthy before starting, but if the DB is slow to initialize on first run, restart the failed service: `docker compose restart worker web`
- `docker compose ps` shows the web service's health state; `curl http://<ip>:3000/api/health` checks it from outside.

**Proxmox page shows no data**
- `WORKER_PROXMOX_ENABLED` defaults to `false`. Set it to `true` in your `.env` along with the `PROXMOX_*` connection vars, then restart the worker.

**Managed hosts aren't reachable / Stacks page shows no hosts**
- Verify the agent is running on the target host: `curl http://<agent-ip>:9090/health`
- Re-enroll the host via the wizard if the keypair is missing (e.g., after a fresh database).

**ZFS host shows no pools**
- The agent needs the host's `zpool`/`zfs` binaries and `/dev/zfs` mounted into its container (the wizard-generated stack includes these). Check the agent logs for "ZFS capability: disabled".

**Port conflict on 3000**
- Set `WEB_PORT` to any available port in your `.env`.
