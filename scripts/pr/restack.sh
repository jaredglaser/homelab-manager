#!/usr/bin/env bash
# Rebase a branch onto a new base and force-push it with a lease, refusing the
# push when the result would make GitHub auto-close a pull request.
set -euo pipefail

usage() {
  cat <<'USAGE'
restack.sh - recover a branch whose base was squash-merged, without losing PRs.

Usage:
  restack.sh <branch> <new-base> <old-parent-tip> [<expected-remote-sha>]
  restack.sh -h

Run it from a detached worktree whose HEAD is the branch tip. It rebases with
`git rebase --onto <new-base> <old-parent-tip>` and pushes with
`--force-with-lease=<branch>:<expected-remote-sha>` (default: current
origin/<branch>).

THE HEAD GATE

The lease protects origin/<branch> only. It says nothing about which commit is
checked out here, so a worktree left at a sibling's tip would get rebased and
pushed over <branch> with the lease satisfied. HEAD must therefore be
<expected-remote-sha>, or be a commit this same worktree already rebased from it
(ORIG_HEAD) that descends from <new-base>, which is the resume path below.
Anything else exits 2 naming both SHAs.

THE AUTO-CLOSE GUARD

GitHub treats "head is an ancestor of base" as merged and closes the pull
request, irreversibly. A force-push inside a stack can produce that state two
ways, and the script checks both against the rebased tip before pushing:

  1. The branch rebases empty, so its own tip becomes an ancestor of <new-base>.
     Its PR closes itself.
  2. The new tip contains the head of another branch. Every PR based on this
     branch closes the moment the push lands.

On either, it stops with exit 3 and names the branches. The fix for case 2 is
Mergify's: repoint each affected PR's base onto the default branch with
mcp__github__update_pull_request BEFORE pushing, push, then repoint them back.
Set RESTACK_ACK_AUTOCLOSE=1 to proceed once that is done.

The guard is local-only. It cannot see which PRs exist or what their bases are,
so it reports candidates, not certainties. Treat a hit as a stop.

Already-restacked branches skip the rebase, so a re-run after a stop at exit 3
is a verify plus the push.
USAGE
}

case "${1:-}" in
  -h | --help) usage; exit 0 ;;
esac
if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then usage; exit 64; fi

branch=$1
new_base=$2
old_parent=$3

git fetch origin --quiet --prune

for ref in "$new_base" "$old_parent"; do
  git rev-parse --verify --quiet "$ref^{commit}" >/dev/null \
    || { echo "restack.sh: no such commit: $ref" >&2; exit 65; }
done

expected=${4:-$(git rev-parse "origin/$branch")}
expected_sha=$(git rev-parse --verify --quiet "$expected^{commit}" || true)
[ -n "$expected_sha" ] || { echo "restack.sh: no such commit: $expected" >&2; exit 65; }

head_sha=$(git rev-parse HEAD)
# The lease guards origin/$branch and never HEAD, so a sibling branch's tip left
# checked out here would be rebased and pushed over $branch, lease still passing.
if [ "$head_sha" != "$expected_sha" ]; then
  rebased_from=$(git rev-parse --verify --quiet ORIG_HEAD || true)
  if [ "$rebased_from" != "$expected_sha" ] \
    || ! git merge-base --is-ancestor "$new_base" "$head_sha" 2>/dev/null; then
    echo "restack.sh: HEAD is $head_sha, but $branch's tip is $expected_sha." >&2
    echo "Detach a worktree at $expected_sha and run it from there, or pass the tip" >&2
    echo "you mean as <expected-remote-sha>." >&2
    exit 2
  fi
  echo "HEAD $head_sha is this worktree's rebase of $expected_sha; skipping to the push"
fi

default_base=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
default_base=${default_base#origin/}
default_base=${default_base:-main}

if git merge-base --is-ancestor "$old_parent" HEAD 2>/dev/null; then
  echo "rebasing $(git rev-parse --short HEAD) --onto $new_base from $old_parent"
  git rebase --onto "$new_base" "$old_parent"
else
  echo "HEAD does not descend from $old_parent; assuming already restacked, skipping rebase"
fi

tip=$(git rev-parse HEAD)
git merge-base --is-ancestor "$new_base" "$tip" \
  || { echo "restack.sh: $tip does not contain $new_base; rebase did not do what you think" >&2; exit 1; }

at_risk=()
if git merge-base --is-ancestor "$tip" "$new_base"; then
  at_risk+=("$branch (rebased empty: its own PR would auto-close)")
fi
while read -r ref; do
  short=${ref#origin/}
  if [ "$short" = "$branch" ] || [ "$short" = "HEAD" ]; then continue; fi
  # Already upstream of the default branch: nothing left to lose.
  if git merge-base --is-ancestor "$ref" "origin/$default_base" 2>/dev/null; then continue; fi
  if git merge-base --is-ancestor "$ref" "$tip" 2>/dev/null; then
    at_risk+=("$short (its head is contained in the new tip)")
  fi
done < <(git for-each-ref --format='%(refname:short)' refs/remotes/origin)

if [ "${#at_risk[@]}" -gt 0 ]; then
  echo >&2
  echo "AUTO-CLOSE HAZARD. Pushing $branch would let GitHub close, irreversibly:" >&2
  printf '  - %s\n' "${at_risk[@]}" >&2
  if [ "${RESTACK_ACK_AUTOCLOSE:-}" != "1" ]; then
    echo >&2
    echo "Repoint every PR based on $branch onto $default_base first" >&2
    echo "(mcp__github__update_pull_request), then re-run with RESTACK_ACK_AUTOCLOSE=1." >&2
    exit 3
  fi
  echo "RESTACK_ACK_AUTOCLOSE=1 set, proceeding." >&2
fi

git push --force-with-lease="$branch:$expected" origin "HEAD:$branch"
echo "pushed $(git rev-parse --short HEAD) to $branch"
