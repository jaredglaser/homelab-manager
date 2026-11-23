#!/bin/bash
# Run from the environment's setup script (docs/cloud-environment.md). Always exits 0:
# a failing setup script blocks every session in the environment.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TOOLS="${HLM_TOOLS_DIR:-$HOME/.hlm-tools}"
export CLAUDE_CODE_REMOTE=true

PIN="$(cat "$REPO/.bun-version")"
if npm install --silent --prefix "$TOOLS/bun" "bun@$PIN"; then
  for existing in $(which -a bun 2>/dev/null) /usr/local/bin/bun; do
    ln -sf "$TOOLS/bun/node_modules/.bin/bun" "$existing"
  done
fi

# The environment cache is only kept when setup finishes in about five minutes.
(cd "$REPO" && timeout 240 bun run setup) > /tmp/hlm-setup-deps.log 2>&1 &
(
  bash "$REPO/scripts/cloud/session-start.sh"
  # Pulled by name: "docker compose pull" refuses to run without the stack's .env values.
  for image in $(grep -E '^\s+image:' "$REPO/docker-compose.local.yml" | awk '{print $2}' | sort -u); do
    timeout 240 docker pull -q "$image" &
  done
  wait
) > /tmp/hlm-setup-images.log 2>&1 &
wait

# Stopped so the environment snapshot holds no pid file or socket from a daemon that is gone.
pkill -x dockerd
for _ in $(seq 1 20); do pgrep -x dockerd >/dev/null || break; sleep 1; done
exit 0
