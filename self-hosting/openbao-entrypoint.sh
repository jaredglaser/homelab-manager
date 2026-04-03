#!/bin/sh
# Start OpenBao with file backend, auto-initialize and unseal on first run.
# Uses HTTP API directly to avoid tty/stdin issues in containers.
# OPENBAO_TOKEN env var is used as the root token on first initialization.

set -e

INIT_FILE="/openbao/data/.init-keys.json"
ROOT_TOKEN="${OPENBAO_TOKEN:?OPENBAO_TOKEN must be set}"
BAO_ADDR="http://127.0.0.1:8200"

# Start server in background
bao server -config=/openbao/config/prod.hcl &
BAO_PID=$!

# Wait for server to accept connections
echo "[openbao-init] Waiting for server..."
SERVER_READY=false
for _ in $(seq 1 30); do
  if wget -q -O /dev/null "$BAO_ADDR/v1/sys/health" 2>/dev/null; then
    SERVER_READY=true
    break
  fi
  # 501=not initialized, 503=sealed — both mean "server is up"
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
  echo "[openbao-init] First start — initializing..."

  wget -q -O "$INIT_FILE" --post-data '{"secret_shares":1,"secret_threshold":1}' \
    --header="Content-Type: application/json" \
    "$BAO_ADDR/v1/sys/init"

  UNSEAL_KEY=$(sed -n 's/.*"keys_base64":\["\([^"]*\)".*/\1/p' "$INIT_FILE")
  BOOTSTRAP_TOKEN=$(sed -n 's/.*"root_token":"\([^"]*\)".*/\1/p' "$INIT_FILE")

  if [ -z "$UNSEAL_KEY" ] || [ -z "$BOOTSTRAP_TOKEN" ]; then
    echo "[openbao-init] ERROR: Failed to extract UNSEAL_KEY or root token from $INIT_FILE"
    exit 1
  fi

  echo "[openbao-init] Unsealing..."
  wget -q -O /dev/null --post-data "{\"key\":\"$UNSEAL_KEY\"}" \
    --header="Content-Type: application/json" \
    "$BAO_ADDR/v1/sys/unseal"

  echo "[openbao-init] Creating application token..."
  TOKEN_RESPONSE=$(wget -q -O - \
    --post-data "{\"id\":\"$ROOT_TOKEN\",\"policies\":[\"root\"],\"no_default_policy\":true,\"no_parent\":true}" \
    --header="Content-Type: application/json" \
    --header="X-Vault-Token: $BOOTSTRAP_TOKEN" \
    "$BAO_ADDR/v1/auth/token/create-orphan" 2>&1) || {
    case "$TOKEN_RESPONSE" in
      *"already exists"*|*"token already"*)
        echo "[openbao-init] Token already exists, continuing." ;;
      *)
        echo "[openbao-init] ERROR: Failed to create token: $TOKEN_RESPONSE"
        exit 1 ;;
    esac
  }

  echo "[openbao-init] Initialization complete."
else
  echo "[openbao-init] Existing data — unsealing..."
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
