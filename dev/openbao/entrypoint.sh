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

# Wait for server to accept connections (200=ready, 501=not init, 503=sealed)
echo "[openbao-init] Waiting for server..."
for i in $(seq 1 30); do
  CODE=$(wget -q -O /dev/null --server-response http://127.0.0.1:8200/v1/sys/health 2>&1 | awk '/HTTP/{print $2}' | tail -1) || true
  case "$CODE" in
    200|429|501|503) break ;;
  esac
  sleep 0.5
done

if [ ! -f "$INIT_FILE" ]; then
  echo "[openbao-init] First start — initializing..."
  bao operator init -key-shares=1 -key-threshold=1 -format=json > "$INIT_FILE"

  # Extract keys using lightweight JSON parsing (no jq in alpine)
  UNSEAL_KEY=$(sed -n 's/.*"unseal_keys_b64":\["\([^"]*\)".*/\1/p' "$INIT_FILE")
  ROOT_TOKEN=$(sed -n 's/.*"root_token":"\([^"]*\)".*/\1/p' "$INIT_FILE")

  echo "[openbao-init] Unsealing..."
  bao operator unseal "$UNSEAL_KEY"

  echo "[openbao-init] Creating dev root token..."
  BAO_TOKEN="$ROOT_TOKEN" bao token create -id="$DEV_ROOT_TOKEN" -policy=root -no-default-policy -orphan || true

  echo "[openbao-init] Done."
else
  echo "[openbao-init] Existing data — unsealing..."
  UNSEAL_KEY=$(sed -n 's/.*"unseal_keys_b64":\["\([^"]*\)".*/\1/p' "$INIT_FILE")
  bao operator unseal "$UNSEAL_KEY"
  echo "[openbao-init] Unsealed."
fi

wait $BAO_PID
