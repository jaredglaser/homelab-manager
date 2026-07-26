#!/usr/bin/env bash
# Local git half of the PR queue state rebuild.
#
# The GitHub half is one mcp__github__list_pull_requests call, which returns
# head.sha, base.ref and updated_at for every open PR. There is no CLI for it
# here: gh is not installed and api.github.com is 403 at the agent proxy, so
# nothing in this file can reach the API.
set -euo pipefail

usage() {
  cat <<'USAGE'
pr-state.sh - per-branch merge and staleness facts for the tracker Queue table.

Usage:
  pr-state.sh <head-branch>[:<base-branch>] [<head-branch>[:<base-branch>] ...]
  pr-state.sh -h

Base branch defaults to the remote HEAD (usually main).

Prints one markdown table row per argument:

  | <head> | <base> | <base-sha> | <head-sha> | clean|CONFLICT | <n> behind |

Read-only. Fetches origin, touches no working tree, safe to run repeatedly.
A branch missing from origin prints a row marked MISSING and does not abort
the run.
USAGE
}

case "${1:-}" in
  -h | --help) usage; exit 0 ;;
  "") usage; exit 64 ;;
esac

git fetch origin --quiet --prune

default_base=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
default_base=${default_base#origin/}
default_base=${default_base:-main}

short() { git rev-parse --short=8 "$1"; }

echo "| Head | Base | Base SHA | Head SHA | Merge | Behind |"
echo "|---|---|---|---|---|---|"

for spec in "$@"; do
  head=${spec%%:*}
  base=${spec#*:}
  if [ "$base" = "$spec" ]; then base=$default_base; fi

  # `|` is legal in a ref name and would shift every cell to its right.
  head_md=${head//|/\\|}
  base_md=${base//|/\\|}

  if ! git rev-parse --verify --quiet "origin/$head^{commit}" >/dev/null; then
    echo "| $head_md | $base_md | | | MISSING | |"
    continue
  fi
  if ! git rev-parse --verify --quiet "origin/$base^{commit}" >/dev/null; then
    echo "| $head_md | $base_md | MISSING | $(short "origin/$head") | | |"
    continue
  fi

  merge=CONFLICT
  if git merge-tree --write-tree "origin/$base" "origin/$head" >/dev/null 2>&1; then
    merge=clean
  fi
  behind=$(git rev-list --count "origin/$head..origin/$base")

  echo "| $head_md | $base_md | $(short "origin/$base") | $(short "origin/$head") | $merge | $behind |"
done
