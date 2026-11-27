#!/bin/bash
# Run from the environment's setup script (docs/cloud-environment.md). Always exits 0:
# a failing setup script blocks every session in the environment.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export CLAUDE_CODE_REMOTE=true
LOGS="${HLM_SETUP_LOG_DIR:-/tmp}"

# The environment cache is only kept when setup finishes in about five minutes.
HLM_START_BUDGET_MS=240000 bash "$REPO/scripts/cloud/session-start.sh" > "$LOGS/hlm-setup-start.log" 2>&1 &
(
  for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
  # Pulled by name: "docker compose pull" refuses to run without the stack's .env values.
  for image in $(grep -E '^\s+image:' "$REPO/docker-compose.local.yml" | awk '{print $2}' | sort -u); do
    timeout 240 docker pull -q "$image" &
  done
  timeout 240 bash "$REPO/scripts/cloud/docker.sh" prepare &
  wait
) > "$LOGS/hlm-setup-images.log" 2>&1 &
wait

# Stopped so the environment snapshot holds no pid file or socket from a daemon that is gone.
pkill -x dockerd
for _ in $(seq 1 20); do pgrep -x dockerd >/dev/null || break; sleep 1; done
exit 0
