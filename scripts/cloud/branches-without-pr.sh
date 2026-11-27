#!/bin/bash
# Lists branches that hold work main lacks and that no open PR carries. REST only: GraphQL is blocked in cloud sessions.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SLUG="${HLM_GITHUB_REPO:-$(git -C "$REPO" remote get-url origin | sed -E 's#\.git$##; s#^.*[/:]([^/:]+/[^/:]+)$#\1#')}"
export SLUG

open_heads="$(gh api "repos/$SLUG/pulls?state=open&per_page=100" --paginate --jq '.[].head.ref')" || exit 1
# A squash merge leaves the branch's commits outside main, so a branch whose tip was merged reads as ahead.
merged_tips="$(gh api "repos/$SLUG/pulls?state=closed&per_page=100" --paginate --jq '.[] | select(.merged_at) | .head.sha')" || exit 1
branches="$(gh api "repos/$SLUG/branches?per_page=100" --paginate --jq '.[] | "\(.name) \(.commit.sha)"')" || exit 1

while read -r name sha; do
  [ -n "$name" ] && [ "$name" != main ] || continue
  grep -qxF -- "$name" <<<"$open_heads" && continue
  grep -qxF -- "$sha" <<<"$merged_tips" && continue
  printf '%s %s\n' "$name" "$sha"
done <<<"$branches" | xargs -r -P 8 -L 1 bash -c '
  read -r ahead files date < <(gh api "repos/$SLUG/compare/main...$2" --jq "[.ahead_by, (.files | length), .commits[-1].commit.committer.date] | @tsv") || exit 0
  [ "${ahead:-0}" -gt 0 ] || exit 0
  days=$(( ($(date +%s) - $(date -d "$date" +%s)) / 86400 ))
  echo "Ahead of main with no open PR: $1, $files files, $days days old."
' _ | sort
