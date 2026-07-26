#!/usr/bin/env bash
# SessionStart hook, matcher "compact": re-inject the pr-queue session pointer
# after a compaction.
#
# Silent no-op (exit 0, no stdout) unless this session has a pr-queue tracker,
# which is what keeps unrelated coding sessions in this repo free of PR digests.
# "Has a tracker" means the state file below exists; the pr-queue skill writes it
# when it creates or finds the tracking issue.
#
# SessionStart is one of the events whose plain stdout is added as context, so
# this prints text rather than building JSON.
set -euo pipefail

usage() {
  cat <<'USAGE'
pr-queue-session-start.sh - SessionStart (matcher: compact) hook.

Reads the hook payload on stdin. Prints a short digest when
${TMPDIR:-/tmp}/claude-pr-queue/<tag>.url exists for this session, otherwise
nothing at all.

<tag> is `pq-` plus the first segment of the session UUID, which appears in the
payload's transcript_path and in the session scratchpad path alike.
USAGE
}

case "${1:-}" in
  -h | --help) usage; exit 0 ;;
esac

payload=$(cat 2>/dev/null || true)
transcript=$(printf '%s' "$payload" \
  | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
uuid=$(printf '%s' "$transcript" \
  | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)
[ -n "$uuid" ] || exit 0

tag="pq-${uuid%%-*}"
state_dir="${TMPDIR:-/tmp}/claude-pr-queue"
[ -f "$state_dir/$tag.url" ] || exit 0

# Each compaction cycle gets exactly one PreCompact nag.
rm -f "$state_dir/$tag.precompact-nagged"

tracker=$(head -1 "$state_dir/$tag.url")
repo="${CLAUDE_PROJECT_DIR:-$PWD}"

branch=$(git -C "$repo" symbolic-ref --quiet --short HEAD 2>/dev/null || echo "detached")
head_sha=$(git -C "$repo" rev-parse --short=8 HEAD 2>/dev/null || echo "?")
dirty=$(git -C "$repo" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
default=$(git -C "$repo" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
default=${default#origin/}
default=${default:-main}
base_sha=$(git -C "$repo" rev-parse --short=8 "origin/$default" 2>/dev/null || echo "?")

cat <<EOF
pr-queue session restored after compaction.

Session tag: $tag
Tracker:     $tracker
Git:         $branch @ $head_sha, $dirty uncommitted path(s); origin/$default @ $base_sha (not fetched)

Read the tracker before acting. Every row in it is a summary you must re-derive
from the API, not a fact. Do not trust a carried-forward mergeable_state.
EOF
