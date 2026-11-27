# Claude Code cloud environment

How to set up a [Claude Code cloud environment](https://code.claude.com/docs/en/cloud-environments) that can run this repo's tests, end-to-end checks and local stack. The `orchestrate` skill (`.claude/skills/orchestrate/`) assumes this setup.

## Environment settings

Create an environment at claude.ai/code and attach this repo.

**Network access:** Custom, with "Allow package managers" ticked. The default list already covers Docker Hub, GHCR and `mirror.gcr.io`, which `dockerd` is started with as a Docker Hub mirror because anonymous Docker Hub pulls from a cloud box are often rate limited. Add the hosts it lacks:

```text
lscr.io
pkg-containers.githubusercontent.com
cdn.playwright.dev
playwright.download.prss.microsoft.com
```

**Environment variables:** the `orchestrate` skill keeps its handoff, criteria and evidence in a separate records repo. Name it here, and attach it to the environment too:

```text
HLM_RECORDS_REPO=<owner>/<records repo>
```

**Setup script:**

```bash
#!/bin/bash
REPO=/home/claude/homelab-manager
[ -d "$REPO/.git" ] || git clone --depth 1 https://github.com/jaredglaser/homelab-manager "$REPO"
[ -f "$REPO/scripts/cloud/setup.sh" ] && bash "$REPO/scripts/cloud/setup.sh"
exit 0
```

`scripts/cloud/setup.sh` runs the start script below, pulls the images in `docker-compose.local.yml`, and prepares the base images for builds.

## What is cached and what is not

The setup script runs when the environment's cache is built: on the first session, after the script or the allowed hosts change, and about weekly. Later sessions start from a snapshot of the disk.

- **Kept:** the pinned Bun, Bun's package cache, pulled images.
- **Not kept:** running processes. `scripts/cloud/session-start.sh` starts `dockerd`, puts Bun on the pin and installs dependencies when they are missing or older than the lockfile, then prints one status line. The SessionStart hook in `.claude/settings.json` runs it. A session with more than one repository attached starts in their parent directory and does not load repo hooks, so run the script first there, from any directory. The `orchestrate` skill runs it as its first step.
- **Possibly stale:** the clone the setup script made. Sessions work in their own fresh checkout.

## Checking a box

```bash
bash scripts/cloud/env-check.sh
```

It reports the Bun pin, whether Docker is running, which stack images are cached, which hosts are reachable, and every branch ahead of main with no open PR.

## Building images

The box reaches the network only through a proxy that re-signs TLS, so builds go through `scripts/cloud/docker.sh`. It takes the base images from `mirror.gcr.io`, adds the proxy's certificate to the local `oven/bun` tag, and gives build steps the proxy. The Dockerfiles stay unchanged.

```bash
bash scripts/cloud/docker.sh build -t hlm-agent ./agent
bash scripts/cloud/docker.sh compose up -d --build   # the local stack, management and oidc profiles
```

## What a box can prove

| Proof type | How |
|---|---|
| `unit` | `bun test --isolate <file>` |
| `run` | Lint rules on fixtures, scripts, a spawned agent entrypoint |
| `e2e` | `bun run e2e:build:app`, serve it, Playwright on the installed Chrome (`channel: 'chrome'`, `--no-sandbox`) |
| `ci` | `gh api repos/jaredglaser/homelab-manager/commits/<sha>/check-runs` and the job logs |
| `stack` | `docker-compose.local.yml` with the management and oidc profiles. Needs Docker running and the images cached or pullable |

## Limits

- GitHub GraphQL is unavailable, so `gh pr` and `gh issue` fail. Use REST through `gh api`.
- The box runs as root (`AGENTS.md#root-container`).
- Memory is limited. Run `test:all`, `typecheck:all`, full `eslint .`, `vite build` and `e2e:build*` one at a time when several agents share a box: `scripts/cloud/heavy.sh <cmd>`. It waits up to 10 minutes for the lock and stops a command after 20.
