# Self-Hosting homelab-manager

A real-time monitoring dashboard for Docker containers, ZFS pools, and Proxmox VE clusters.

> [!WARNING]
> **Stack management and agent functionality are currently unstable and under active development.** Expect breaking changes, incomplete features, and rough edges. Use at your own risk.

> [!WARNING]
> **Do not expose this dashboard to the public internet.** There is no built-in authentication - anyone who can reach the port can view your infrastructure and change settings. The service is not hardened for untrusted networks. Keep it on your LAN, and ideally isolate it further with a dedicated lab VLAN or a firewall rule that restricts access to specific hosts.
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

Copy the template below into a `.env` file in the same directory and fill in your values:

```env
# PostgreSQL
POSTGRES_DB=homelab
POSTGRES_USER=homelab
POSTGRES_PASSWORD=changeme   # change this

# Master encryption key for stack secrets and per-agent keypairs
# Generate with: openssl rand -base64 32
MASTER_KEY=changeme          # replace with a generated key
```

See [Configuration](#configuration) for all available options.

**3. Start**

```bash
docker compose up -d
```

Open `http://<your-server-ip>:3000` (or whichever port you set via `WEB_PORT`).

**4. Stop**

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
| `worker` | `ghcr.io/jaredglaser/homelab-manager-worker` | Background collector - connects to agent sidecars (Docker/ZFS) and polls Proxmox, writes stats to TimescaleDB |
| `web` | `ghcr.io/jaredglaser/homelab-manager-web` | Dashboard UI and API server. Streams stats from TimescaleDB to connected clients via SSE. |

> **Note:** Images are published to GitHub Container Registry ([web](https://github.com/jaredglaser/homelab-manager/pkgs/container/homelab-manager-web), [worker](https://github.com/jaredglaser/homelab-manager/pkgs/container/homelab-manager-worker)) on every push to `main`. The project is pre-release and not yet versioned - use `latest` for now and watch the changelog for breaking changes before pulling updates.

---

## Configuration

All configuration is done via environment variables in your `.env` file.

### Required

| Variable | Description |
|----------|-------------|
| `POSTGRES_DB` | Database name |
| `POSTGRES_USER` | Database user |
| `POSTGRES_PASSWORD` | Database password |
| `MASTER_KEY` | Base64-encoded 256-bit key for at-rest encryption of stack secrets and agent keypairs. Generate with `openssl rand -base64 32`. |

### Web Server

| Variable | Default | Description |
|----------|---------|-------------|
| `WEB_PORT` | `3000` | Host port for the dashboard |

### Reverse Proxy

Any reverse proxy works. [Caddy](https://caddyserver.com/docs/) is a popular homelab choice - refer to its docs for setup.

**Keep the dashboard on your LAN.** A reverse proxy does not change the security posture described in the warning above. Do not route this dashboard through a public-facing proxy.

**Authentication layer:** Since the dashboard has no built-in auth, consider placing an auth middleware in front of it. [tinyauth](https://github.com/steveiliop56/tinyauth) paired with [Pocket ID](https://github.com/stonith404/pocket-id) (a lightweight OIDC/passkey provider built for homelabs) is a clean option: Pocket ID manages your identity store, tinyauth enforces login at the proxy layer, and the dashboard itself stays unchanged. Treat this as defense-in-depth on top of network isolation, not a replacement for it.

### Docker Monitoring

Docker monitoring works through agent sidecars. Deploy the agent container on each host you want to monitor, then register the host in **Settings → Managed Hosts** with the `docker` capability enabled. The worker subscribes to the agent's SSE streams for stats and container inventory; no direct Docker socket access is required on the dashboard host.

> **Setup:** See the [Docker Stack Management](#docker-stack-management) section below for the agent deploy flow. The same agent serves both monitoring and deploy operations.

### ZFS Monitoring

ZFS monitoring works through agent sidecars (the same agents used for Docker management). When you register a managed host with ZFS capability, the worker connects to the agent's `/zfs/stats/stream` SSE endpoint to receive real-time `zpool iostat` data. No SSH configuration is needed.

> **Setup:** Deploy the agent container on a host with ZFS pools, then register the host in **Settings → Managed Hosts** with the `zfs` capability enabled. The agent auto-detects ZFS by checking for the `zpool` binary at startup.

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

Stack management lets you deploy and manage Docker Compose stacks on your hosts via the dashboard. Authentication uses short-lived JWTs signed by a per-host Ed25519 keypair stored encrypted in the database; no token file is distributed to hosts.

| Variable | Default | Description |
|----------|---------|-------------|
| `GIT_SERVER_TOKEN` | - | Token for authenticating git pushes to the built-in git server |

> **How it works:** Each managed Docker host runs a lightweight agent container that the dashboard communicates with for deploy operations. When you enroll a host, the dashboard generates an Ed25519 keypair, encrypts the private key with `MASTER_KEY`, and sends the public JWK to the agent. Each deploy request carries a short-lived signed JWT; the agent verifies it against the trusted public key.
>
> **Adding a host:** Use **Settings → Managed Hosts → Add Host** in the dashboard. The wizard generates a compose snippet for the agent and handles key exchange during the Verify step. Once connectivity is confirmed, the keypair is stored and the host is ready.

### PostgreSQL Connection

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_SSL` | `false` | Enable TLS for the PostgreSQL connection |
| `POSTGRES_SSL_REJECT_UNAUTHORIZED` | `true` | Verify the server's TLS certificate. Set to `false` only for self-signed certificates -- this disables chain validation and exposes the connection to MITM attacks. |
| `POSTGRES_POOL_SIZE` | `10` | Database connection pool size |

### Worker Behavior

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_ENABLED` | `true` | Enable the background collector |
| `WORKER_DOCKER_ENABLED` | `true` | Enable Docker stats collection |
| `WORKER_ZFS_ENABLED` | `false` | Enable ZFS stats collection |
| `WORKER_PROXMOX_ENABLED` | `false` | Enable Proxmox stats collection |
| `WORKER_COLLECTION_INTERVAL_MS` | `1000` | Collection interval in milliseconds |
| `WORKER_LOCALHOST_AGENT` | - | Docker-internal hostname to substitute for `localhost` agent URLs (e.g. `hlm-agent`). Set this when the worker and an agent container run on the same Docker host; without it, `localhost` agent URLs resolve to the worker container itself rather than the agent container. |

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

# Docker: no env vars needed; register hosts with the Docker capability
# in Settings → Managed Hosts after deploying an agent sidecar.

# ZFS: no env vars needed; register hosts with ZFS capability
# in Settings → Managed Hosts after deploying an agent sidecar

# Proxmox VE
PROXMOX_HOST=192.168.1.100
PROXMOX_TOKEN_ID=root@pam!monitoring
PROXMOX_TOKEN_SECRET=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# Worker
# WORKER_ENABLED=true
# WORKER_DOCKER_ENABLED=true
# WORKER_ZFS_ENABLED=false
WORKER_PROXMOX_ENABLED=true
# WORKER_COLLECTION_INTERVAL_MS=1000

# Stack management
# GIT_SERVER_TOKEN=a-random-token-for-git-auth
```

---

## Updating

Pull the latest images and recreate containers:

```bash
docker compose pull
docker compose up -d
```

## Troubleshooting

**Dashboard shows no data**
- Check the worker logs: `docker compose logs -f worker`
- Verify your Docker/ZFS/Proxmox host is reachable from the container: `docker compose exec worker ping <host>`

**Database connection errors**
- The web and worker services wait for the database to be healthy before starting, but if the DB is slow to initialize on first run, restart the failed service: `docker compose restart worker web`

**Proxmox page shows no data**
- `WORKER_PROXMOX_ENABLED` defaults to `false`. Set it to `true` in your `.env` along with the `PROXMOX_*` connection vars, then restart the worker.

**Managed hosts aren't reachable / Stacks page shows no hosts**
- Verify the agent is running on the target host: `curl http://<agent-ip>:9090/health`
- Re-enroll the host via the wizard if the keypair is missing (e.g., after a fresh database).

**Port conflict on 3000**
- Set `WEB_PORT` to any available port in your `.env`.
