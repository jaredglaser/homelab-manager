#!/bin/sh
# Start OpenBao with file backend, auto-initialize and unseal on first run.
# On subsequent starts, unseal with the stored key.
#
# This gives dev-mode convenience (fixed root token, auto-unseal)
# with production-mode persistence (file storage backend).

set -e

INIT_FILE="/openbao/data/.init-keys.json"
DEV_ROOT_TOKEN="dev-root-token"

# Start server in background
bao server -config=/openbao/config/local.hcl &
BAO_PID=$!

# Wait for server to be ready
for i in $(seq 1 30); do
  if wget -q --spider http://127.0.0.1:8200/v1/sys/health 2>/dev/null; then
    break
  fi
  # Accept 501 (not initialized) and 503 (sealed) as "ready"
  STATUS=$(wget -q -O /dev/null -S http://127.0.0.1:8200/v1/sys/health 2>&1 | grep "HTTP/" | awk '{print $2}' || true)
  if [ "$STATUS" = "501" ] || [ "$STATUS" = "503" ]; then
    break
  fi
  sleep 0.5
done

if [ ! -f "$INIT_FILE" ]; then
  echo "[openbao-init] First start — initializing vault..."
  # Initialize with 1 key share, 1 threshold (dev-friendly)
  bao operator init -key-shares=1 -key-threshold=1 -format=json > "$INIT_FILE"

  UNSEAL_KEY=$(cat "$INIT_FILE" | grep -o '"unseal_keys_b64":\[\"[^"]*\"' | sed 's/.*\["//' | sed 's/".*//')
  ROOT_TOKEN=$(cat "$INIT_FILE" | grep -o '"root_token":"[^"]*"' | sed 's/"root_token":"//' | sed 's/"//')

  echo "[openbao-init] Unsealing..."
  echo "$UNSEAL_KEY" | bao operator unseal -

  # Replace the auto-generated root token with our fixed dev token
  echo "[openbao-init] Setting dev root token..."
  export BAO_TOKEN="$ROOT_TOKEN"
  bao token create -id="$DEV_ROOT_TOKEN" -policy=root -no-default-policy -orphan 2>/dev/null || true

  echo "[openbao-init] Initialization complete."
else
  echo "[openbao-init] Existing data found — unsealing..."
  UNSEAL_KEY=$(cat "$INIT_FILE" | grep -o '"unseal_keys_b64":\[\"[^"]*\"' | sed 's/.*\["//' | sed 's/".*//')
  echo "$UNSEAL_KEY" | bao operator unseal -
  echo "[openbao-init] Unsealed."
fi

# Foreground the server
wait $BAO_PID
