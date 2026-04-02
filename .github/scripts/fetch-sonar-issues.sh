#!/usr/bin/env bash
set -euo pipefail

# Fetch open SonarQube issues and write them to sonar-issues.json.
# Paginates through all results up to 10,000 (SonarQube API max).
#
# Required env vars:
#   SONAR_HOST_URL     - Base URL of the SonarQube instance
#   SONAR_TOKEN        - API token (Bearer auth, requires SonarQube 10.x or later)
#   SONAR_PROJECT_KEY  - Project key in SonarQube
#
# Optional env vars:
#   SEVERITY_FILTER    - Max severity to include (MINOR|MAJOR|CRITICAL, default: MINOR)
#   OUTPUT_FILE        - Output path (default: sonar-issues.json)

SEVERITY_FILTER="${SEVERITY_FILTER:-MINOR}"
OUTPUT_FILE="${OUTPUT_FILE:-sonar-issues.json}"

# Map severity filter to the list of severities to include
case "$SEVERITY_FILTER" in
  MINOR)    SEVERITIES="INFO,MINOR" ;;
  MAJOR)    SEVERITIES="INFO,MINOR,MAJOR" ;;
  CRITICAL) SEVERITIES="INFO,MINOR,MAJOR,CRITICAL" ;;
  *)
    echo "ERROR: Unknown SEVERITY_FILTER '${SEVERITY_FILTER}'. Use MINOR, MAJOR, or CRITICAL." >&2
    exit 1
    ;;
esac

# Guard: ensure required secrets are non-empty before making any network calls
for VAR in SONAR_HOST_URL SONAR_TOKEN SONAR_PROJECT_KEY; do
  if [ -z "${!VAR:-}" ]; then
    echo "ERROR: Required environment variable '${VAR}' is empty or unset. Ensure the secret is configured in repository Settings → Secrets." >&2
    exit 1
  fi
done

echo "Fetching SonarQube issues..."
echo "  Host:       ${SONAR_HOST_URL}"
echo "  Project:    ${SONAR_PROJECT_KEY}"
echo "  Severities: ${SEVERITIES}"

PAGE=1
PAGE_SIZE=100
TOTAL=-1
FETCHED=0
MAX_PAGES=$((10000 / PAGE_SIZE))

# Use a temp file to accumulate pages — avoids ARG_MAX limits with large payloads
PAGES_DIR=$(mktemp -d)
trap 'rm -rf "$PAGES_DIR"' EXIT

# Pass token via header, not --user, to keep it out of the process list.
# Bearer token auth requires SonarQube 10.x or later.
# For older versions, user tokens use Basic auth:
#   Authorization: Basic $(echo -n "${SONAR_TOKEN}:" | base64)
AUTH_HEADER="Authorization: Bearer ${SONAR_TOKEN}"

while true; do
  set +e
  curl --silent --show-error --fail-with-body \
    --write-out "%{http_code}" \
    --output "${PAGES_DIR}/curl_response.tmp" \
    -H "$AUTH_HEADER" \
    "${SONAR_HOST_URL}/api/issues/search?projectKeys=${SONAR_PROJECT_KEY}&statuses=OPEN,CONFIRMED,REOPENED&severities=${SEVERITIES}&types=CODE_SMELL,BUG&ps=${PAGE_SIZE}&p=${PAGE}" \
    > "${PAGES_DIR}/curl_status.tmp" 2>"${PAGES_DIR}/curl_stderr.tmp"
  CURL_EXIT=$?
  set -e

  HTTP_STATUS=$(cat "${PAGES_DIR}/curl_status.tmp" 2>/dev/null || echo "")

  if [ -z "$HTTP_STATUS" ] || [ "$HTTP_STATUS" = "000" ]; then
    echo "ERROR: curl failed at network level (exit ${CURL_EXIT})." >&2
    cat "${PAGES_DIR}/curl_stderr.tmp" >&2
    exit 1
  fi

  if [ "${HTTP_STATUS}" -lt 200 ] || [ "${HTTP_STATUS}" -ge 300 ]; then
    echo "ERROR: SonarQube API returned HTTP ${HTTP_STATUS}." >&2
    echo "Response preview:" >&2
    head -c 500 "${PAGES_DIR}/curl_response.tmp" >&2
    exit 1
  fi

  RESPONSE=$(cat "${PAGES_DIR}/curl_response.tmp")

  # Extract total on first page
  if [ "$TOTAL" -eq -1 ]; then
    TOTAL=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('total', 0))")
    if ! [[ "$TOTAL" =~ ^[0-9]+$ ]]; then
      echo "ERROR: Could not parse 'total' from SonarQube response (got: '${TOTAL}')." >&2
      exit 1
    fi
    echo "  Total issues found: ${TOTAL}"
  fi

  PAGE_JSON=$(echo "$RESPONSE" | python3 -c "
import sys, json
data = json.load(sys.stdin)
issues = data.get('issues', [])
print(json.dumps(issues))
")
  PAGE_COUNT=$(echo "$PAGE_JSON" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")
  echo "$PAGE_JSON" > "${PAGES_DIR}/page_$(printf '%04d' $PAGE).json"

  FETCHED=$((FETCHED + PAGE_COUNT))
  echo "  Fetched so far: ${FETCHED}/${TOTAL}"

  if [ "$FETCHED" -ge "$TOTAL" ]; then
    break
  fi

  # SonarQube caps at 10,000 results
  if [ "$FETCHED" -ge 10000 ]; then
    echo "WARNING: Reached 10,000 issue limit. Some issues may be omitted." >&2
    break
  fi

  PAGE=$((PAGE + 1))

  # Guard against runaway pagination beyond the SonarQube API maximum
  if [ "$PAGE" -gt "$MAX_PAGES" ]; then
    echo "WARNING: Reached maximum page limit (${MAX_PAGES} pages). Some issues may be omitted." >&2
    break
  fi
done

# Merge all page files into the final output
python3 - "$PAGES_DIR" "$OUTPUT_FILE" <<'PYEOF'
import json, sys, pathlib
pages_dir, output_file = sys.argv[1], sys.argv[2]
all_issues = []
for p in sorted(pathlib.Path(pages_dir).glob("page_*.json")):
    all_issues.extend(json.loads(p.read_text()))
pathlib.Path(output_file).write_text(json.dumps(all_issues, indent=2))
print(f"Wrote {len(all_issues)} issues to {output_file}")
PYEOF
