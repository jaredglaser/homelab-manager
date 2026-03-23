#!/bin/sh
# dev/openbao/setup-transit.sh
# Enable Transit engine and create encryption keys for local dev

BAO_ADDR="${BAO_ADDR:-http://127.0.0.1:8200}"
BAO_TOKEN="${BAO_TOKEN:-dev-root-token}"

echo "[openbao-transit] Checking Transit engine..."

# Check if transit/ is already mounted
MOUNTS=$(wget -q -O - --header="X-Vault-Token: $BAO_TOKEN" "$BAO_ADDR/v1/sys/mounts" 2>/dev/null)
if echo "$MOUNTS" | grep -q '"transit/"'; then
  echo "[openbao-transit] Transit engine already mounted."
else
  echo "[openbao-transit] Enabling Transit engine..."
  wget -q -O /dev/null --post-data '{"type":"transit"}' \
    --header="Content-Type: application/json" \
    --header="X-Vault-Token: $BAO_TOKEN" \
    "$BAO_ADDR/v1/sys/mounts/transit"
fi

# Create encryption keys (idempotent — POST to existing key is a no-op)
for KEY_NAME in session-tokens agent-tokens git-tokens; do
  echo "[openbao-transit] Ensuring key: $KEY_NAME"
  wget -q -O /dev/null --post-data '{"type":"aes256-gcm96"}' \
    --header="Content-Type: application/json" \
    --header="X-Vault-Token: $BAO_TOKEN" \
    "$BAO_ADDR/v1/transit/keys/$KEY_NAME" 2>/dev/null || true
done

# Store dev OIDC client secret (for local testing)
echo "[openbao-transit] Storing dev OIDC client secret..."
wget -q -O /dev/null --post-data '{"data":{"value":"dev-oidc-client-secret"}}' \
  --header="Content-Type: application/json" \
  --header="X-Vault-Token: $BAO_TOKEN" \
  "$BAO_ADDR/v1/secret/data/stacks/oidc/client-secret" 2>/dev/null || true

echo "[openbao-transit] Setup complete."
