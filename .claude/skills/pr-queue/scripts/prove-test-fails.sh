#!/usr/bin/env bash
# Prove one test fails without the fix it is supposed to guard.
set -euo pipefail

usage() {
  cat <<'USAGE'
prove-test-fails.sh - revert one file to its base revision, run one test, restore.

Usage:
  prove-test-fails.sh <base-sha> <source-file> <test-file> <test-name>
  prove-test-fails.sh -h

Reverts <source-file> to <base-sha>, runs `bun test <test-file> -t <test-name>`,
then restores both the working tree copy and the index entry. Uncommitted edits
in <source-file> survive, which a bare `git checkout <sha> -- <file>` would not.

Exit 0 means the test FAILED without the fix, which is the wanted outcome.
Exit 1 means it passed anyway and therefore guards nothing.

Read the printed failure text: a test can fail for the wrong reason.
Safe to run repeatedly; restore runs from an EXIT trap.
USAGE
}

case "${1:-}" in
  -h | --help) usage; exit 0 ;;
esac
if [ "$#" -ne 4 ]; then usage; exit 64; fi

base_sha=$1
source_file=$2
test_file=$3
test_name=$4

git rev-parse --verify --quiet "$base_sha^{commit}" >/dev/null \
  || { echo "prove-test-fails.sh: no such commit: $base_sha" >&2; exit 65; }
[ -f "$source_file" ] || { echo "prove-test-fails.sh: no such file: $source_file" >&2; exit 66; }

saved=$(mktemp)
cp "$source_file" "$saved"
staged_before=$(git diff --cached --name-only -- "$source_file")

restore() {
  cp "$saved" "$source_file"
  # `git checkout <sha> -- <file>` also writes the index. Undo that unless the
  # file was already staged before this ran.
  if [ -z "$staged_before" ]; then
    git restore --staged -- "$source_file" 2>/dev/null || true
  fi
  rm -f "$saved"
}
trap restore EXIT

git checkout "$base_sha" -- "$source_file"

echo "--- running without the fix: $test_file -t \"$test_name\" ---"
set +e
bun test "$test_file" -t "$test_name"
status=$?
set -e

if [ "$status" -eq 0 ]; then
  echo "PASSED without the fix. This test guards nothing." >&2
  exit 1
fi
echo "Failed without the fix, as wanted. Read the failure text above before believing it."
