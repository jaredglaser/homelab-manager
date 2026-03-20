# Git Stacks Repository

homelab-manager stores Docker Compose stack definitions in an in-app bare git repository. This repo is managed by isomorphic-git inside the web server container — you don't need an external git server.

## How It Works

- The repo is initialized automatically at startup when `DOCKER_MANAGEMENT_FEATURE_FLAG=true`
- Location: `$GIT_REPOS_DIR/stacks.git` (default `/data/repos/stacks.git`)
- Contains a `manifest.yaml` (lists stacks and deploy settings) and per-stack `<stack-name>/docker-compose.yml` files
- Pushes to the repo trigger the deploy pipeline (post-receive hook diffs commits, identifies changed stacks, builds deploy requests)

## Connecting to the Repo

The repo is accessible via Git HTTP smart protocol at:

```
http://localhost:3000/api/git/stacks
```

Authentication uses a Bearer token set via `GIT_SERVER_TOKEN` in your `.env`.

### Clone

```bash
git clone http://localhost:3000/api/git/stacks stacks
```

When prompted for credentials, use any username and the `GIT_SERVER_TOKEN` value as the password. Or configure the token in the URL:

```bash
git clone http://x:dev-git-token@localhost:3000/api/git/stacks stacks
```

> **Note:** The `x` username is ignored — only the password (token) matters.

### Adding a Stack

1. Clone the repo (see above)
2. Create a directory for your stack and add a compose file:

```bash
cd stacks
mkdir my-app
cat > my-app/docker-compose.yml << 'EOF'
services:
  app:
    image: caddy:2-alpine
    ports:
      - "8082:80"
    restart: unless-stopped
EOF
```

3. Register the stack in the manifest:

```bash
cat > manifest.yaml << 'EOF'
stacks:
  my-app:
    host: desktop
    autoDeploy: false
EOF
```

4. Commit and push:

```bash
git add -A
git commit -m "Add my-app stack"
git push
```

The push triggers the post-receive hook. If `autoDeploy: true`, the deploy pipeline sends the compose file to the agent on the specified host. If `autoDeploy: false`, the stack appears on the stacks page as "pending" and can be deployed manually from the UI.

### Manifest Format

```yaml
stacks:
  <stack-name>:
    host: <managed-host-name>    # Must match a host added via the UI
    autoDeploy: true|false       # Auto-deploy on push, or require manual deploy
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GIT_REPOS_DIR` | `/data/repos` | Directory for bare git repos (inside the container) |
| `GIT_SERVER_TOKEN` | — | Bearer token for git HTTP authentication (required) |

Both must be set in your `.env` when `DOCKER_MANAGEMENT_FEATURE_FLAG=true`.

## Local Development

When running with `bun dev` (web server locally), the git repo is created at `$GIT_REPOS_DIR/stacks.git` on your local filesystem. The default `/data/repos` may not be writable, so set it to a local path:

```env
GIT_REPOS_DIR="./data/repos"
```

The repo URL is the same: `http://localhost:3000/api/git/stacks`.

## Troubleshooting

**"Git server token not configured" (500)**
Set `GIT_SERVER_TOKEN` in your `.env` and restart the web server.

**"Unauthorized" (401)**
Check that you're passing the token. With curl: `curl -H "Authorization: Bearer dev-git-token" http://localhost:3000/api/git/stacks/info/refs?service=git-upload-pack`

**Clone hangs or times out**
The git HTTP endpoint requires `DOCKER_MANAGEMENT_FEATURE_FLAG=true`. Without it, the route returns 404.

**Push succeeds but stack doesn't appear**
Check that the stack is listed in `manifest.yaml` and the `host` value matches a managed host name.
