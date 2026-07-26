#!/usr/bin/env bash
# PreCompact hook: make the pr-queue orchestrator flush tracker state before the
# summary is written.
#
# Silent no-op (exit 0, no stdout) unless this session has a pr-queue tracker.
# PreCompact has no matcher and cannot inject additionalContext, and its plain
# stdout reaches only the debug log, so the one channel that reaches the model is
# `decision: block` with a reason. That blocks the compaction, so it fires at
# most once per compaction cycle: this hook drops a marker and the SessionStart
# compact hook clears it. If the agent ignores the block, the retry proceeds.
set -euo pipefail

usage() {
  cat <<'USAGE'
pr-queue-pre-compact.sh - PreCompact hook.

Reads the hook payload on stdin. Emits a one-shot blocking decision asking for a
tracker flush when ${TMPDIR:-/tmp}/claude-pr-queue/<tag>.url exists for this
session and the marker for this compaction cycle is not yet set. Otherwise
prints nothing and exits 0.
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
if [ -e "$state_dir/$tag.precompact-nagged" ]; then exit 0; fi
: > "$state_dir/$tag.precompact-nagged"

# Only URL-safe characters survive, so the reason stays valid JSON without jq.
tracker=$(head -1 "$state_dir/$tag.url" | tr -cd 'A-Za-z0-9:/._~%?#=&+-')

printf '{"decision":"block","reason":"%s"}\n' \
  "Compaction is about to discard this context. Flush pr-queue session $tag to the tracker first: update ${tracker} so every Queue row, the Last check line (base branch SHA, consecutive no-ops) and the In flight table match what you know right now, then let the compaction proceed. This block fires once per compaction cycle."
