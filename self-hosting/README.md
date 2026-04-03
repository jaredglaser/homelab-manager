# Self-Hosting homelab-manager

A real-time monitoring dashboard for Docker containers, ZFS pools, and Proxmox VE clusters.

> [!WARNING]
> **Do not expose this dashboard to the public internet.** There is no built-in authentication - anyone who can reach the port can view your infrastructure and change settings. The service is not hardened for untrusted networks. Keep it on your LAN, and ideally isolate it further with a dedicated lab VLAN or a firewall rule that restricts access to specific hosts.
>
> For remote access, use a VPN tunnel back to your home network rather than port-forwarding. [Tailscale](https://tailscale.com) and [WireGuard](https://www.wireguard.com) are both solid options: install the client on your phone or laptop, connect to your homelab's VPN, and access the dashboard at its local IP as if you were home.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) 24+
- [Docker Compose](https://docs.docker.com/compose/install/) v2.20+

## Quick Start

**1. Download the compose files**

```bash
curl -O https://raw.githubusercontent.com/jaredglaser/homelab-manager/main/self-hosting/docker-compose.yml
curl -O https://raw.githubusercontent.com/jaredglaser/homelab-manager/main/self-hosting/openbao-entrypoint.sh
curl -O https://raw.githubusercontent.com/jaredglaser/homelab-manager/main/self-hosting/openbao.hcl
chmod +x openbao-entrypoint.sh
```

**2. Create a `.env` file**

Copy the template below into a `.env` file in the same directory and fill in your values:

```env
# PostgreSQL
POSTGRES_DB=homelab
POSTGRES_USER=homelab
POSTGRES_PASSWORD=changeme   # change this

# OpenBao (secrets storage for managed host agent tokens)
OPENBAO_TOKEN=changeme       # change this — use a long random string
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

Data is persisted in Docker volumes (`pgdata`, `openbao-data`, `git-repos`) and survives restarts. To wipe everything:

```bash
docker compose down -v
```

---

## Services

| Service | Image | Description |
|---------|-------|-------------|
| `postgres` | `timescale/timescaledb:latest-pg16` | Time-series database (infinite retention, automatic compression after 7 days). Runs with `synchronous_commit=off` - up to ~200ms of stats can be lost on a hard crash, which is acceptable for monitoring data where transaction latency matters more than durability. |
| `openbao` | `openbao/openbao` | Secrets storage for agent tokens used by managed Docker hosts. Auto-initializes and unseals on first start. |
| `worker` | `ghcr.io/jaredglaser/homelab-manager-worker` | Background collector - polls Docker, ZFS, and Proxmox hosts, writes stats to TimescaleDB |
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
| `OPENBAO_TOKEN` | Root token for OpenBao secrets storage — use a long random string |

### Web Server

| Variable | Default | Description |
|----------|---------|-------------|
| `WEB_PORT` | `3000` | Host port for the dashboard |

### Reverse Proxy

Any reverse proxy works. [Caddy](https://caddyserver.com/docs/) is a popular homelab choice - refer to its docs for setup.

**Keep the dashboard on your LAN.** A reverse proxy does not change the security posture described in the warning above. Do not route this dashboard through a public-facing proxy.

**Authentication layer:** Since the dashboard has no built-in auth, consider placing an auth middleware in front of it. [tinyauth](https://github.com/steveiliop56/tinyauth) paired with [Pocket ID](https://github.com/stonith404/pocket-id) (a lightweight OIDC/passkey provider built for homelabs) is a clean option: Pocket ID manages your identity store, tinyauth enforces login at the proxy layer, and the dashboard itself stays unchanged. Treat this as defense-in-depth on top of network isolation, not a replacement for it.

### Docker Monitoring

Monitor Docker hosts by configuring one or more hosts. Each host is numbered (`_1`, `_2`, `_3`).

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCKER_HOST_1` | - | Docker host IP or hostname |
| `DOCKER_HOST_PORT_1` | `2375` | Socket proxy port |
| `DOCKER_HOST_NAME_1` | - | Display name shown in the dashboard |

> **Docker host setup:** Run a **Docker socket proxy** on each monitored host rather than exposing the raw Docker daemon socket over TCP. [`lscr.io/linuxserver/socket-proxy`](https://github.com/linuxserver/docker-socket-proxy) binds to a TCP port and forwards only the API calls you allow. Point `DOCKER_HOST_1` at the proxy's address and port.
>
> **Local deployment** (homelab-manager runs on the same host): Bind the socket proxy to `127.0.0.1:2375` and set `DOCKER_HOST_1` to `host.docker.internal` (or run the worker with `network_mode: host`) so the container can reach the host's localhost.
>
> **Remote deployment** (monitoring a separate host): Bind the socket proxy to `0.0.0.0:2375` (or the host's specific management IP) and set `DOCKER_HOST_1` to that host's IP/hostname. Restrict access via firewall rules or a dedicated management VLAN — only the homelab-manager worker should reach the proxy port.
>
> Example socket proxy compose service (monitoring only — read-only access):
>
> ```yaml
> services:
>   socket-proxy:
>     image: lscr.io/linuxserver/socket-proxy:latest
>     container_name: socket-proxy
>     ports:
>       - 127.0.0.1:2375:2375  # Local: bind to localhost. Remote: change to 0.0.0.0:2375
>     environment:
>       - CONTAINERS=1
>       - EVENTS=1
>       - INFO=1
>       - PING=1
>       - VERSION=1
>       - TZ=America/New_York  # Set to your local timezone
>     volumes:
>       - /var/run/docker.sock:/var/run/docker.sock:ro
>     restart: unless-stopped
>     read_only: true
>     tmpfs:
>       - /run
> ```

### ZFS Monitoring

Monitor ZFS pools over SSH. Each host is numbered (`_1`, `_2`, `_3`).

| Variable | Default | Description |
|----------|---------|-------------|
| `ZFS_HOST_1` | - | SSH host IP or hostname |
| `ZFS_HOST_PORT_1` | `22` | SSH port |
| `ZFS_HOST_NAME_1` | - | Display name shown in the dashboard |
| `ZFS_HOST_USER_1` | - | SSH username |
| `ZFS_HOST_KEY_PATH_1` | - | Path to SSH private key inside the container (see below) |
| `ZFS_HOST_KEY_PASSPHRASE_1` | - | Passphrase for the private key (if encrypted) |
| `ZFS_HOST_PASSWORD_1` | - | SSH password (alternative to key auth) |

> **SSH key setup:** Place your private key on the host running homelab-manager at `/mnt/appdata/homelab-manager/keys/`. The compose file bind-mounts this directory into the worker container at `/keys` (read-only). Reference the key as `/keys/<filename>` in `ZFS_HOST_KEY_PATH_1`. Create the directory first: `mkdir -p /mnt/appdata/homelab-manager/keys && chmod 700 /mnt/appdata/homelab-manager/keys`.
>
> **ZFS permissions:** The SSH user needs permission to run `zpool iostat`. A targeted sudoers rule is safer than adding the user to `wheel`:
> ```
> username ALL=(ALL) NOPASSWD: /usr/sbin/zpool iostat *
> ```

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

Stack management lets you deploy and manage Docker Compose stacks on your hosts via the dashboard. Agent tokens are stored in OpenBao — no `.env` file or token file is distributed to hosts.

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCKER_MANAGEMENT_FEATURE_FLAG` | `false` | Set to `true` to enable the Stacks UI |
| `GIT_SERVER_TOKEN` | - | Token for authenticating git pushes to the built-in git server |

> **How it works:** Each managed Docker host runs a lightweight agent container that the dashboard communicates with for deploy operations. The agent's auth token is stored in OpenBao (the `openbao` service in this compose) and never written to disk outside of it.
>
> **Adding a host:** Deploy the agent on your Docker host, then register it in **Settings → Managed Hosts** by providing the agent's URL and token. The dashboard verifies connectivity before saving.
>
> **Agent setup:** The agent needs access to the Docker daemon on its host. Run a socket proxy alongside it with the permissions the agent requires:
>
> ```yaml
> services:
>   socket-proxy:
>     image: lscr.io/linuxserver/socket-proxy:latest
>     container_name: hlm-socket-proxy
>     environment:
>       - CONTAINERS=1
>       - EVENTS=1
>       - INFO=1
>       - IMAGES=1
>       - NETWORKS=1
>       - VOLUMES=1
>       - VERSION=1
>       - ALLOW_START=1
>       - ALLOW_STOP=1
>       - ALLOW_RESTARTS=1
>       - EXEC=1
>     volumes:
>       - /var/run/docker.sock:/var/run/docker.sock:ro
>     restart: unless-stopped
>     read_only: true
>     tmpfs:
>       - /run
>
>   agent:
>     image: ghcr.io/jaredglaser/homelab-manager-agent:latest
>     container_name: hlm-agent
>     ports:
>       - "9090:9090"   # Port the dashboard connects to
>     environment:
>       - DOCKER_HOST=tcp://socket-proxy:2375
>       - AGENT_TOKEN=your-agent-token   # Must match what you enter in Settings
>       - AGENT_PORT=9090
>     restart: unless-stopped
> ```

### Worker Behavior

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_ENABLED` | `true` | Enable the background collector |
| `WORKER_DOCKER_ENABLED` | `true` | Enable Docker stats collection |
| `WORKER_ZFS_ENABLED` | `false` | Enable ZFS stats collection |
| `WORKER_PROXMOX_ENABLED` | `true` | Enable Proxmox stats collection |
| `WORKER_COLLECTION_INTERVAL_MS` | `1000` | Collection interval in milliseconds |
| `WORKER_BATCH_SIZE` | `10` | Number of rows to batch per INSERT |
| `WORKER_BATCH_TIMEOUT_MS` | `1000` | Max time before flushing a partial batch |
| `POSTGRES_POOL_SIZE` | `10` | Database connection pool size |

---

## Full `.env` Example

```env
# PostgreSQL
POSTGRES_DB=homelab
POSTGRES_USER=homelab
POSTGRES_PASSWORD=a-strong-password-here

# OpenBao
OPENBAO_TOKEN=a-long-random-string-here

# Docker host (add _2, _3 for additional hosts)
DOCKER_HOST_1=192.168.1.10
DOCKER_HOST_PORT_1=2375
DOCKER_HOST_NAME_1=my-server

# ZFS host (add _2, _3 for additional hosts)
ZFS_HOST_1=192.168.1.10
ZFS_HOST_PORT_1=22
ZFS_HOST_NAME_1=my-server
ZFS_HOST_USER_1=admin
ZFS_HOST_KEY_PATH_1=/keys/zfs_id_ed25519

# Proxmox VE
PROXMOX_HOST=192.168.1.100
PROXMOX_TOKEN_ID=root@pam!monitoring
PROXMOX_TOKEN_SECRET=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# Worker
WORKER_ZFS_ENABLED=true

# Stack management (optional)
# DOCKER_MANAGEMENT_FEATURE_FLAG=true
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

**Port conflict on 3000**
- Set `WEB_PORT` to any available port in your `.env`.

**OpenBao fails to start**
- Ensure `OPENBAO_TOKEN` is set in your `.env`.
- Check logs: `docker compose logs openbao`
- The `openbao-data` volume persists the init keys — do not delete it unless you intend to reinitialize.
