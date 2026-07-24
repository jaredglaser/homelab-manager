# Homelab Manager

[![CI](https://github.com/jaredglaser/homelab-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/jaredglaser/homelab-manager/actions/workflows/ci.yml)
[![Demo](https://img.shields.io/badge/demo-live-blue)](https://jaredglaser.github.io/homelab-manager/)

> A real-time monitoring dashboard for homelab infrastructure, built on TanStack Start.

> [!NOTE]
> **Try the live demo** at [jaredglaser.github.io/homelab-manager](https://jaredglaser.github.io/homelab-manager/) - no setup required. The demo runs entirely in the browser with deterministic mock data.

> [!NOTE]
> **Want to run this yourself?** See the [self-hosting guide](self-hosting/README.md) for setup instructions using pre-built Docker images.

> [!WARNING]
> This project is a **work in progress**. Features are incomplete, APIs may change, and the codebase is under active development. See [Roadmap](#roadmap) for planned features.

> [!WARNING]
> **Stack management and agent functionality are currently unstable and under active development.** Expect breaking changes, incomplete features, and rough edges. Use at your own risk.

## Overview

Homelab Manager is a **one-stop-shop dashboard** for monitoring and managing Docker hosts, Proxmox clusters, and Docker Compose stacks from a single interface. Agent sidecars on each managed host stream stats into TimescaleDB, and the frontend streams them in real time via Server-Sent Events.

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | System diagrams, data streaming pipeline, and how the two-stage collection works |
| [Development Guide](docs/development.md) | Prerequisites, environment setup, running locally, and testing |
| [Local OIDC Dev](docs/dev-oidc.md) | Pocket ID setup, dev users, one-time login URLs, and token refresh |
| [Git Stacks Repo](docs/git-stacks-repo.md) | In-app git repository: cloning, tokens, manifest schema, push-to-deploy |
| [Project Structure](docs/project-structure.md) | Full directory tree with file descriptions |
| [Tech Stack](docs/tech-stack.md) | All technologies and their roles |
| [Self-Hosting Guide](self-hosting/README.md) | Deploy with pre-built Docker images |

## Features

- **Docker Dashboard** - Real-time CPU, memory, block I/O, and network metrics for all containers with inline sparkline charts
- **ZFS Dashboard** - Hierarchical view of pools, vdevs, and disks with capacity, IOPS, and bandwidth metrics via agent sidecar
- **Proxmox Dashboard** - Cluster overview with per-node CPU, memory, and disk metrics via REST API polling
- **Stack Management** - GitOps-style Docker Compose stack management with in-app editor (Monaco + YAML validation), deploy, teardown, rollback, and deploy history
- **Host Management** - Add and configure managed Docker hosts via a setup wizard; agent sidecars handle stats streaming, log access, and deployments
- **Secrets Management** - JWE-encrypted stack secrets and per-agent keypairs stored in TimescaleDB
- **TimescaleDB Persistence** - 1-second collection interval with automatic compression and indefinite retention
- **Live-Updating UI** - SSE streaming with shared server-side polling (1 DB query/sec per source, regardless of client count)
- **Cross-Browser Sync** - User preferences persisted and synced across tabs via a dedicated SSE channel
- **Virtualized Tables** - Shared DataTable with CSS Grid + conditional contained virtualization for large datasets
- **Stale Detection** - Per-entity amber highlighting when a host or container stops reporting

## Quick Start

The fastest path is the pre-built Docker images. Download the compose file and a `.env`, then bring it up:

```bash
mkdir homelab-manager && cd homelab-manager
curl -O https://raw.githubusercontent.com/jaredglaser/homelab-manager/main/self-hosting/docker-compose.yml
# Create a .env with POSTGRES_*, MASTER_KEY, and an auth choice
# (OIDC or AUTH_DISABLED=true; see the self-hosting guide)
docker compose up -d
```

Open http://localhost:3000.

Full instructions: [Self-Hosting Guide](self-hosting/README.md). For local development setup (source checkout, HMR, sample data), see the [Development Guide](docs/development.md).

## Roadmap

- [x] TimescaleDB persistence with automatic compression
- [x] Docker Compose deployment (multi-container)
- [x] Database-backed streaming via shared server-side polling
- [x] Historical data UI with time-bucketed charts
- [x] Proxmox API integration
- [x] Stack management with GitOps deploy pipeline
- [x] Host management UI with agent sidecar provisioning
- [x] Encrypted-at-rest stack secrets and agent keypairs (JWE)
- [x] Agent-updater sidecar for automatic container updates
- [x] Pre-built Docker image on a container registry
- [x] Live demo deployed to GitHub Pages
- [x] Authentication (OIDC with Pocket ID support): required by default with `AUTH_DISABLED=true` as the opt-out; setup documented in the [self-hosting guide](self-hosting/README.md#authentication-oidc)
- [ ] Return to TanStack Start streaming server functions (pending upstream abort signal fix)

## AI Disclosure

AI tools are used during development, particularly in early-stage prototyping and testing. **All code is fully human-reviewed** before being merged. The codebase is under active refactoring to ensure it is readable, well-structured, and efficient.

## License

This project is licensed under the [Apache License 2.0](LICENSE).

All dependencies use permissive licenses compatible with Apache 2.0. License compliance is verified automatically in CI using [license-checker-rseidelsohn](https://github.com/RSeidelsohn/license-checker-rseidelsohn).
