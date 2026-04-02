#!/usr/bin/env bash
set -euo pipefail

# Fetch open SonarQube issues and write them to sonar-issues.json.
# Paginates through all results up to 10,000 (SonarQube API max).
#
# Required env vars:
#   SONAR_HOST_URL     - Base URL of the SonarQube instance
#   SONAR_TOKEN        - API token (Basic auth, password field)
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

echo "Fetching SonarQube issues..."
echo "  Host:       ${SONAR_HOST_URL}"
echo "  Project:    ${SONAR_PROJECT_KEY}"
echo "  Severities: ${SEVERITIES}"

PAGE=1
PAGE_SIZE=100
TOTAL=-1
FETCHED=0

# Use a temp file to accumulate pages — avoids ARG_MAX limits with large payloads
PAGES_DIR=$(mktemp -d)
trap 'rm -rf "$PAGES_DIR"' EXIT

# Pass token via header, not --user, to keep it out of the process list
AUTH_HEADER="Authorization: Bearer ${SONAR_TOKEN}"

while true; do
  RESPONSE=$(curl --silent --fail \
    -H "$AUTH_HEADER" \
    "${SONAR_HOST_URL}/api/issues/search?projectKeys=${SONAR_PROJECT_KEY}&statuses=OPEN,CONFIRMED,REOPENED&severities=${SEVERITIES}&types=CODE_SMELL,BUG&ps=${PAGE_SIZE}&p=${PAGE}")

  # Extract total on first page
  if [ "$TOTAL" -eq -1 ]; then
    TOTAL=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('total', 0))")
    echo "  Total issues found: ${TOTAL}"
  fi

  echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('issues', [])))" \
    > "${PAGES_DIR}/page_${PAGE}.json"

  FETCHED=$((FETCHED + $(python3 -c "import json,sys; print(len(json.load(open('${PAGES_DIR}/page_${PAGE}.json'))))")))
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
