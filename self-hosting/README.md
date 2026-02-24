# Self-Hosting homelab-manager

A real-time monitoring dashboard for Docker containers, ZFS pools, and Proxmox VE clusters.

> [!WARNING]
> **Do not expose this dashboard to the public internet.** There is no built-in authentication — anyone who can reach the port can view your infrastructure and change settings. The service is not hardened for untrusted networks. Keep it on your LAN, and ideally isolate it further with a dedicated lab VLAN or a firewall rule that restricts access to specific hosts.
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

# Web server port
WEB_PORT=3000
```

See [Configuration](#configuration) for all available options.

**3. Start**

```bash
docker compose up -d
```

Open [http://localhost:3000](http://localhost:3000) (or whichever port you set).

**4. Stop**

```bash
docker compose down
```

Data is persisted in a Docker volume (`pgdata`) and survives restarts. To wipe everything:

```bash
docker compose down -v
```

---

## Services

| Service | Image | Description |
|---------|-------|-------------|
| `postgres` | `timescale/timescaledb:latest-pg16` | Time-series database (7-day retention, automatic compression) |
| `worker` | `ghcr.io/jaredglaser/homelab-manager-worker` | Background collector — polls Docker/ZFS hosts and writes to DB |
| `web` | `ghcr.io/jaredglaser/homelab-manager-web` | Dashboard UI and API server |

> **Note:** Images are published to [GitHub Container Registry](https://github.com/jaredglaser/homelab-manager/pkgs/container/homelab-manager-web) on every push to `main`. Pin to a specific version tag (e.g., `v1.2.0`) for stable deployments.

---

## Configuration

All configuration is done via environment variables in your `.env` file.

### Required

| Variable | Description |
|----------|-------------|
| `POSTGRES_DB` | Database name |
| `POSTGRES_USER` | Database user |
| `POSTGRES_PASSWORD` | Database password |

### Web Server

| Variable | Default | Description |
|----------|---------|-------------|
| `WEB_PORT` | `3000` | Host port for the dashboard |

### Docker Monitoring

Monitor Docker hosts by configuring one or more hosts. Each host is numbered (`_1`, `_2`, `_3`).

| Variable | Default | Description |
|----------|---------|-------------|
| `DOCKER_HOST_1` | — | Docker host IP or hostname |
| `DOCKER_HOST_PORT_1` | `2375` | Docker API port (TCP, no TLS) |
| `DOCKER_HOST_NAME_1` | — | Display name shown in the dashboard |

> **Docker host setup:** Enable TCP on the remote Docker daemon by adding `-H tcp://0.0.0.0:2375` to its startup flags. Keep this port firewalled — it has no authentication.

### ZFS Monitoring

Monitor ZFS pools over SSH. Each host is numbered (`_1`, `_2`, `_3`).

| Variable | Default | Description |
|----------|---------|-------------|
| `ZFS_HOST_1` | — | SSH host IP or hostname |
| `ZFS_HOST_PORT_1` | `22` | SSH port |
| `ZFS_HOST_NAME_1` | — | Display name shown in the dashboard |
| `ZFS_HOST_USER_1` | — | SSH username |
| `ZFS_HOST_KEY_PATH_1` | — | Path to SSH private key (recommended) |
| `ZFS_HOST_KEY_PASSPHRASE_1` | — | Passphrase for the private key (if encrypted) |
| `ZFS_HOST_PASSWORD_1` | — | SSH password (alternative to key auth) |

> **ZFS permissions:** The SSH user needs permission to run `zpool iostat`. Add the user to the `wheel`/`sudo` group or configure a targeted sudoers rule.

### Proxmox VE Monitoring

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXMOX_HOST` | — | Proxmox VE hostname or IP |
| `PROXMOX_PORT` | `8006` | Proxmox API port |
| `PROXMOX_TOKEN_ID` | — | API token ID (`USER@REALM!TOKENID`) |
| `PROXMOX_TOKEN_SECRET` | — | API token secret (UUID) |
| `PROXMOX_ALLOW_SELF_SIGNED` | `true` | Allow self-signed TLS certificates |

> **Proxmox API token:** Create one via **Datacenter > Permissions > API Tokens**. The token needs `PVEAuditor` role (read-only) on `/` for cluster overview data.

### Worker Behavior

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_ENABLED` | `true` | Enable the background collector |
| `WORKER_DOCKER_ENABLED` | `true` | Enable Docker stats collection |
| `WORKER_ZFS_ENABLED` | `false` | Enable ZFS stats collection |
| `WORKER_COLLECTION_INTERVAL_MS` | `1000` | Collection interval in milliseconds |
| `POSTGRES_POOL_SIZE` | `10` | Database connection pool size |

---

## Full `.env` Example

```env
# PostgreSQL
POSTGRES_DB=homelab
POSTGRES_USER=homelab
POSTGRES_PASSWORD=a-strong-password-here

# Web server
WEB_PORT=3000

# Docker host (add _2, _3 for additional hosts)
DOCKER_HOST_1=192.168.1.10
DOCKER_HOST_PORT_1=2375
DOCKER_HOST_NAME_1=my-server

# ZFS host (add _2, _3 for additional hosts)
ZFS_HOST_1=192.168.1.10
ZFS_HOST_PORT_1=22
ZFS_HOST_NAME_1=my-server
ZFS_HOST_USER_1=admin
ZFS_HOST_KEY_PATH_1=/run/secrets/zfs_ssh_key

# Proxmox VE
PROXMOX_HOST=192.168.1.100
PROXMOX_TOKEN_ID=root@pam!monitoring
PROXMOX_TOKEN_SECRET=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# Worker
WORKER_ZFS_ENABLED=true
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
