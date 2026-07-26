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
then puts back the working tree copy (content and file mode) and the exact index
entry it found, including staged content that differs from both HEAD and the
working tree. A bare `git checkout <sha> -- <file>` overwrites all three.

Refuses a symlinked <source-file> rather than writing through the link.

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
[ ! -L "$source_file" ] \
  || { echo "prove-test-fails.sh: refusing a symlink: $source_file" >&2; exit 66; }
[ -f "$source_file" ] || { echo "prove-test-fails.sh: no such file: $source_file" >&2; exit 66; }

top=$(git rev-parse --show-toplevel)
source_abs=$(cd "$(dirname "$source_file")" && pwd)/$(basename "$source_file")
rel=${source_abs#"$top"/}
[ "$rel" != "$source_abs" ] \
  || { echo "prove-test-fails.sh: $source_file is outside $top" >&2; exit 66; }

backup=$(mktemp -d)
cp -a "$source_file" "$backup/blob"
index_entry=$(git -C "$top" ls-files -s --full-name -- "$rel")

restore() {
  rm -f "$source_abs"
  cp -a "$backup/blob" "$source_abs"
  if [ -n "$index_entry" ]; then
    printf '%s\n' "$index_entry" | git -C "$top" update-index --index-info
  else
    git -C "$top" rm --cached --quiet --force -- "$rel" 2>/dev/null || true
  fi
  rm -rf "$backup"
}
trap restore EXIT

git -C "$top" checkout "$base_sha" -- "$rel"

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
