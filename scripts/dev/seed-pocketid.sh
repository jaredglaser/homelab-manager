#!/bin/sh
# Idempotent seeder for Pocket ID local dev setup.
# Creates groups, users, an OIDC client, and one-time login tokens,
# then writes .env.development.local and data/dev-oidc-logins.txt.
#
# Required env vars (set by docker-compose.local.yml):
#   POCKET_ID_URL         - e.g. http://pocket-id:1411
#   POCKET_ID_API_KEY     - value of STATIC_API_KEY in pocket-id service
#   APP_CALLBACK_URL      - e.g. http://localhost:3000/api/auth/callback
#   OUTPUT_ENV_FILE       - path to write OIDC env vars
#   OUTPUT_LOGINS_FILE    - path to write one-time login URLs

set -eu

API="${POCKET_ID_URL}/api"
AUTH_HEADER="X-API-Key: ${POCKET_ID_API_KEY}"

log() { printf '[seed-pocketid] %s\n' "$1" >&2; }

# ---------------------------------------------------------------------------
# Helpers: parse a JSON string field from a single-level object.
# No jq dependency; uses only sh builtins + sed + grep.
# ---------------------------------------------------------------------------

# get_field <json> <field>
get_field() {
  printf '%s' "$1" | grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*"[^"]*"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/'
}

# get_array_first_id <json_array_string>
# Returns the id of the first element in a "data":[{...}] array.
get_first_id() {
  printf '%s' "$1" | grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)".*/\1/'
}

# ---------------------------------------------------------------------------
# Step 1: Groups
# ---------------------------------------------------------------------------
log "Step 1: ensuring user groups..."

ensure_group() {
  name="$1"
  friendly="$2"

  resp=$(curl -sf -H "${AUTH_HEADER}" "${API}/user-groups?search=${name}")
  id=$(get_first_id "$resp")

  if [ -z "$id" ]; then
    log "  creating group '${name}'"
    resp=$(curl -sf -H "${AUTH_HEADER}" -H 'Content-Type: application/json' \
      -X POST "${API}/user-groups" \
      -d "{\"name\":\"${name}\",\"friendlyName\":\"${friendly}\"}")
    id=$(get_field "$resp" "id")
    if [ -z "$id" ]; then
      log "  ERROR: failed to create group '${name}': ${resp}"
      exit 1
    fi
  else
    log "  group '${name}' already exists (id=${id})"
  fi

  printf '%s' "$id"
}

GROUP_ADMINS=$(ensure_group "homelab-admins" "Homelab Admins")
GROUP_OPERATORS=$(ensure_group "homelab-operators" "Homelab Operators")
GROUP_VIEWERS=$(ensure_group "homelab-viewers" "Homelab Viewers")

# ---------------------------------------------------------------------------
# Step 2: Users
# ---------------------------------------------------------------------------
log "Step 2: ensuring users..."

ensure_user() {
  username="$1"
  first_name="$2"
  is_admin="$3"
  group_id="$4"

  resp=$(curl -sf -H "${AUTH_HEADER}" "${API}/users?search=${username}")
  id=$(get_first_id "$resp")

  if [ -z "$id" ]; then
    log "  creating user '${username}'"
    resp=$(curl -sf -H "${AUTH_HEADER}" -H 'Content-Type: application/json' \
      -X POST "${API}/users" \
      -d "{\"username\":\"${username}\",\"firstName\":\"${first_name}\",\"lastName\":\"Dev\",\"email\":\"${username}@localhost\",\"isAdmin\":${is_admin},\"userGroupIds\":[\"${group_id}\"]}")
    id=$(get_field "$resp" "id")
    if [ -z "$id" ]; then
      log "  ERROR: failed to create user '${username}': ${resp}"
      exit 1
    fi
  else
    log "  user '${username}' already exists (id=${id})"
  fi

  printf '%s' "$id"
}

USER_ADMIN_ID=$(ensure_user "dev-admin" "Dev Admin" "true" "${GROUP_ADMINS}")
USER_OPERATOR_ID=$(ensure_user "dev-operator" "Dev Operator" "false" "${GROUP_OPERATORS}")
USER_VIEWER_ID=$(ensure_user "dev-viewer" "Dev Viewer" "false" "${GROUP_VIEWERS}")

# ---------------------------------------------------------------------------
# Step 3: OIDC client (idempotent create, always rotate secret)
# ---------------------------------------------------------------------------
log "Step 3: ensuring OIDC client..."

CLIENT_ID="homelab-manager-dev"

resp=$(curl -sf -H "${AUTH_HEADER}" "${API}/oidc/clients")
existing_id=$(printf '%s' "$resp" | grep -o "\"id\"[[:space:]]*:[[:space:]]*\"${CLIENT_ID}\"" | head -1)

if [ -z "$existing_id" ]; then
  log "  creating OIDC client '${CLIENT_ID}'"
  curl -sf -H "${AUTH_HEADER}" -H 'Content-Type: application/json' \
    -X POST "${API}/oidc/clients" \
    -d "{\"id\":\"${CLIENT_ID}\",\"name\":\"Homelab Manager (dev)\",\"callbackURLs\":[\"${APP_CALLBACK_URL}\"],\"isPublic\":false}" \
    > /dev/null
else
  log "  OIDC client '${CLIENT_ID}' already exists"
fi

log "  rotating OIDC client secret..."
secret_resp=$(curl -sf -H "${AUTH_HEADER}" -H 'Content-Type: application/json' \
  -X POST "${API}/oidc/clients/${CLIENT_ID}/secret" \
  -d '{}')
CLIENT_SECRET=$(get_field "$secret_resp" "secret")
if [ -z "$CLIENT_SECRET" ]; then
  log "  ERROR: failed to rotate client secret: ${secret_resp}"
  exit 1
fi
log "  client secret rotated"

# ---------------------------------------------------------------------------
# Step 4: One-time login tokens (720-hour TTL)
# ---------------------------------------------------------------------------
log "Step 4: generating one-time login tokens..."

get_one_time_token() {
  user_id="$1"
  resp=$(curl -sf -H "${AUTH_HEADER}" -H 'Content-Type: application/json' \
    -X POST "${API}/users/${user_id}/one-time-access-token" \
    -d '{"ttl":"720h"}')
  token=$(get_field "$resp" "token")
  if [ -z "$token" ]; then
    log "  ERROR: failed to get token for user ${user_id}: ${resp}"
    exit 1
  fi
  printf '%s' "$token"
}

TOKEN_ADMIN=$(get_one_time_token "${USER_ADMIN_ID}")
TOKEN_OPERATOR=$(get_one_time_token "${USER_OPERATOR_ID}")
TOKEN_VIEWER=$(get_one_time_token "${USER_VIEWER_ID}")

# ---------------------------------------------------------------------------
# Step 5: Write output files
# ---------------------------------------------------------------------------
log "Step 5: writing output files..."

# Rewrite internal container URL to the host-accessible URL for the browser.
# The seeder runs inside Docker but the browser (on the host) calls localhost:1411.
ISSUER_URL_EXTERNAL=$(printf '%s' "${POCKET_ID_URL}" | sed 's|http://pocket-id:|http://localhost:|')

cat > "${OUTPUT_ENV_FILE}" <<EOF
# Auto-generated by pocket-id-seeder. Do not edit manually; re-run dev:local:up to regenerate.
AUTH_ENABLED=true
OIDC_ISSUER_URL=${ISSUER_URL_EXTERNAL}
OIDC_CLIENT_ID=${CLIENT_ID}
OIDC_CLIENT_SECRET=${CLIENT_SECRET}
OIDC_REDIRECT_URI=${APP_CALLBACK_URL}
OIDC_ROLE_ADMIN=homelab-admins
OIDC_ROLE_OPERATOR=homelab-operators
OIDC_ROLE_VIEWER=homelab-viewers
EOF

mkdir -p "$(dirname "${OUTPUT_LOGINS_FILE}")"
cat > "${OUTPUT_LOGINS_FILE}" <<EOF
# Auto-generated by pocket-id-seeder. Re-run dev:local:up or dev:local:restart to regenerate tokens.
# Each URL is a one-time login link (valid 720h). Opening it in a browser logs you in as that role.

admin (role: admin):
  ${ISSUER_URL_EXTERNAL}/lc/${TOKEN_ADMIN}

dev-operator (role: operator):
  ${ISSUER_URL_EXTERNAL}/lc/${TOKEN_OPERATOR}

dev-viewer (role: viewer):
  ${ISSUER_URL_EXTERNAL}/lc/${TOKEN_VIEWER}
EOF

log "Wrote ${OUTPUT_ENV_FILE}"
log "Wrote ${OUTPUT_LOGINS_FILE}"
log "Done. Start the dev server with: bun dev"
