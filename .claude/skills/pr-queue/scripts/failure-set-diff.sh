#!/usr/bin/env bash
# Compare the test failure set on a branch against the failure set on its base,
# for the case where the local suite cannot be made green at all.
set -euo pipefail

usage() {
  cat <<'USAGE'
failure-set-diff.sh - which tests fail on the branch that do not fail on the base.

Usage:
  failure-set-diff.sh <base-sha> <fix-worktree> [<scratch-dir>]
  failure-set-diff.sh -h

Builds a detached worktree at <base-sha> under <scratch-dir> (default: the
parent of <fix-worktree>), runs `bun run setup && bun run test:all` in it and in
<fix-worktree>, and diffs the sorted (fail) lines.

Prints two sets:
  fails only on the branch  -> yours, and the number that matters
  fails only on the base    -> tests your branch fixed or stopped running

Re-running reuses an existing base worktree instead of failing on it, and
overwrites the previous output files. Never uses `git stash`: .git/refs/stash is
shared across every worktree in this repo.
USAGE
}

case "${1:-}" in
  -h | --help) usage; exit 0 ;;
esac
if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then usage; exit 64; fi

base_sha=$1
fix_wt=$2
[ -d "$fix_wt" ] || { echo "failure-set-diff.sh: no such worktree: $fix_wt" >&2; exit 66; }
fix_wt=$(cd "$fix_wt" && pwd)
scratch=${3:-$(dirname "$fix_wt")}

git -C "$fix_wt" rev-parse --verify --quiet "$base_sha^{commit}" >/dev/null \
  || { echo "failure-set-diff.sh: no such commit: $base_sha" >&2; exit 65; }

short=$(git -C "$fix_wt" rev-parse --short=8 "$base_sha")
base_wt="$scratch/wt-base-$short"
out="$scratch/failure-set-diff-$short"
mkdir -p "$out"

if [ -d "$base_wt" ]; then
  echo "reusing base worktree $base_wt"
else
  git -C "$fix_wt" worktree add --detach "$base_wt" "$base_sha"
fi

collect() {
  local dir=$1 dest=$2
  (cd "$dir" && bun run setup >/dev/null 2>&1 || true)
  (cd "$dir" && bun run test:all 2>&1 || true) \
    | grep -E "^\(fail\)" \
    | sed 's/ \[[0-9.]*ms\]$//' \
    | sort -u > "$dest"
}

collect "$base_wt" "$out/base-fails.txt"
collect "$fix_wt" "$out/fix-fails.txt"

echo
echo "base  ($short): $(wc -l < "$out/base-fails.txt") failing"
echo "fix   (branch): $(wc -l < "$out/fix-fails.txt") failing"
echo
echo "--- fails only on the branch (yours) ---"
comm -13 "$out/base-fails.txt" "$out/fix-fails.txt"
echo "--- fails only on the base ---"
comm -23 "$out/base-fails.txt" "$out/fix-fails.txt"
echo
echo "raw sets: $out"
