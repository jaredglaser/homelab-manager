#!/bin/bash
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
row() { printf '%-42s %s\n' "$1" "$2"; }

echo "== Box"
row "cpus / memory" "$(nproc) cpus, $(free -g | awk '/^Mem:/{print $2}') GB"
row "free disk" "$(df -h --output=avail / | tail -1 | tr -d ' ')"

echo "== Bun"
PIN="$(cat "$REPO/.bun-version")"
for bin in $(which -a bun 2>/dev/null | sort -u); do
  version="$("$bin" --version 2>/dev/null)"
  row "$bin" "$version $([ "$version" = "$PIN" ] && echo '(matches pin)' || echo "(PIN IS $PIN)")"
done
row "node_modules" "$([ -d "$REPO/node_modules" ] && echo installed || echo 'missing: run bun run setup')"

echo "== Docker"
CLAUDE_CODE_REMOTE=true bash "$REPO/scripts/cloud/session-start.sh"
if docker info >/dev/null 2>&1; then
  row "dockerd" "running"
  for image in $(grep -E '^\s+image:' "$REPO/docker-compose.local.yml" | awk '{print $2}' | sort -u); do
    row "$image" "$(docker image inspect "$image" >/dev/null 2>&1 && echo cached || echo 'not cached')"
  done
else
  row "dockerd" "NOT RUNNING (see /tmp/dockerd.log)"
fi

echo "== Network (401 and 404 still mean reachable, 000 means refused)"
for host in registry-1.docker.io/v2/ auth.docker.io/token production.cloudflare.docker.com/ ghcr.io/v2/ \
            pkg-containers.githubusercontent.com/ lscr.io/v2/ cdn.playwright.dev/ \
            playwright.download.prss.microsoft.com/ registry.npmjs.org/bun; do
  row "$host" "$(curl -s -o /dev/null -m 10 -w '%{http_code}' "https://$host")"
done

echo "== GitHub"
row "git read of this repo" "$(git -C "$REPO" ls-remote origin HEAD >/dev/null 2>&1 && echo ok || echo FAILED)"
if [ -n "$HLM_RECORDS_REPO" ]; then
  row "git read of the records repo" "$(git ls-remote "https://github.com/$HLM_RECORDS_REPO" >/dev/null 2>&1 && echo ok || echo FAILED)"
else
  row "records repo" "HLM_RECORDS_REPO is not set"
fi

echo "== Branches"
if branches="$(bash "$REPO/scripts/cloud/branches-without-pr.sh")"; then
  [ -n "$branches" ] && echo "$branches" || row "ahead of main with no open PR" "none"
else
  row "ahead of main with no open PR" "FAILED (GitHub REST)"
fi
