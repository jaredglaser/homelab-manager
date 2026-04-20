#!/bin/sh
# Start OpenBao with file backend, auto-initialize and unseal on first run.
# Uses HTTP API directly (not CLI) to avoid tty/stdin issues in containers.

set -e

INIT_FILE="/openbao/data/.init-keys.json"
DEV_ROOT_TOKEN="dev-root-token"
BAO_ADDR="http://127.0.0.1:8200"

# Start server in background
bao server -config=/openbao/config/local.hcl &
BAO_PID=$!

# Wait for server to accept connections
echo "[openbao-init] Waiting for server..."
SERVER_READY=false
for _ in $(seq 1 30); do
  if wget -q -O /dev/null "$BAO_ADDR/v1/sys/health" 2>/dev/null; then
    SERVER_READY=true
    break
  fi
  # 501=not initialized, 503=sealed (both mean "server is up")
  if wget -q -O /dev/null "$BAO_ADDR/v1/sys/seal-status" 2>/dev/null; then
    SERVER_READY=true
    break
  fi
  sleep 0.5
done

if [ "$SERVER_READY" != "true" ]; then
  echo "[openbao-init] ERROR: Server did not start within 15s"
  exit 1
fi

if [ ! -f "$INIT_FILE" ]; then
  echo "[openbao-init] First start: initializing..."

  # Initialize via HTTP API
  wget -q -O "$INIT_FILE" --post-data '{"secret_shares":1,"secret_threshold":1}' \
    --header="Content-Type: application/json" \
    "$BAO_ADDR/v1/sys/init"

  # Extract unseal key and root token from JSON response.
  # These sed patterns assume OpenBao emits compact single-line JSON (no whitespace
  # between keys/values). If the format ever changes, replace with jq.
  UNSEAL_KEY=$(sed -n 's/.*"keys_base64":\["\([^"]*\)".*/\1/p' "$INIT_FILE")
  ROOT_TOKEN=$(sed -n 's/.*"root_token":"\([^"]*\)".*/\1/p' "$INIT_FILE")

  if [ -z "$UNSEAL_KEY" ] || [ -z "$ROOT_TOKEN" ]; then
    echo "[openbao-init] ERROR: Failed to extract UNSEAL_KEY or ROOT_TOKEN from $INIT_FILE"
    exit 1
  fi

  echo "[openbao-init] Unsealing..."
  wget -q -O /dev/null --post-data "{\"key\":\"$UNSEAL_KEY\"}" \
    --header="Content-Type: application/json" \
    "$BAO_ADDR/v1/sys/unseal"

  # Create our fixed dev root token
  echo "[openbao-init] Creating dev root token..."
  TOKEN_RESPONSE=$(wget -q -O - --post-data "{\"id\":\"$DEV_ROOT_TOKEN\",\"policies\":[\"root\"],\"no_default_policy\":true,\"no_parent\":true}" \
    --header="Content-Type: application/json" \
    --header="X-Vault-Token: $ROOT_TOKEN" \
    "$BAO_ADDR/v1/auth/token/create-orphan" 2>&1) || {
    # Token may already exist from a prior run; check for known error patterns
    case "$TOKEN_RESPONSE" in
      *"already exists"*|*"token already"*)
        echo "[openbao-init] Dev root token already exists, continuing." ;;
      *)
        echo "[openbao-init] ERROR: Failed to create dev root token: $TOKEN_RESPONSE"
        exit 1 ;;
    esac
  }

  echo "[openbao-init] Initialization complete."
else
  echo "[openbao-init] Existing data: unsealing..."
  UNSEAL_KEY=$(sed -n 's/.*"keys_base64":\["\([^"]*\)".*/\1/p' "$INIT_FILE")

  if [ -z "$UNSEAL_KEY" ]; then
    echo "[openbao-init] ERROR: Failed to extract UNSEAL_KEY from $INIT_FILE"
    exit 1
  fi

  wget -q -O /dev/null --post-data "{\"key\":\"$UNSEAL_KEY\"}" \
    --header="Content-Type: application/json" \
    "$BAO_ADDR/v1/sys/unseal"

  echo "[openbao-init] Unsealed."
fi

wait $BAO_PID
