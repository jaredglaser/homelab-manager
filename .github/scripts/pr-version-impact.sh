#!/usr/bin/env bash
# Post or update the single "Version impact" comment on a pull request: what
# release-please will do to the release version when this PR merges. The squash
# commit subject is the PR title, so the title alone decides the classification;
# the PR body is consulted only for BREAKING CHANGE footers, matching
# release-please's parser. Bump rules mirror release-please's
# DefaultVersioningStrategy with bump-minor-pre-major and
# bump-patch-for-minor-pre-major (see release-please-config.json).
#
# Usage: pr-version-impact.sh           (needs GH_TOKEN, PR_NUMBER, PR_TITLE,
#                                        PR_BODY, GITHUB_REPOSITORY)
#        pr-version-impact.sh --self-test   (no network, checks the matrix)
#
# Requires gh >= 2.53 and jq.
set -euo pipefail

MARKER="<!-- version-impact -->"
RE_TYPE='^([A-Za-z]+)(\([^)]*\))?!?:'
RE_BREAKING='^[A-Za-z]+(\([^)]*\))?!:'
RE_BREAKING_NOTE='BREAKING[ -]CHANGE:( |$)'
KNOWN_TYPES="feat fix perf revert chore docs style refactor test build ci"

# classify TITLE BODY -> PARSED (yes/no), TYPE, BREAKING (yes/no)
classify() {
  local title="$1" body="$2"
  PARSED=no TYPE="" BREAKING=no
  if [[ "$title" =~ $RE_TYPE ]]; then
    PARSED=yes
    TYPE="${BASH_REMATCH[1]}"
  fi
  if [[ "$title" =~ $RE_BREAKING ]] || grep -qE "$RE_BREAKING_NOTE" <<<"$body"; then
    BREAKING=yes
  fi
}

# contrib_kind VERSION -> none|patch|minor|major
contrib_kind() {
  local version="$1" pre_major=no
  if [ "$PARSED" = no ]; then echo none; return; fi
  [ "${version%%.*}" = "0" ] && pre_major=yes
  if [ "$BREAKING" = yes ]; then
    if [ "$pre_major" = yes ]; then echo minor; else echo major; fi
    return
  fi
  if [ "$pre_major" = yes ]; then echo patch; return; fi
  case "$TYPE" in feat|feature) echo minor ;; *) echo patch ;; esac
}

# bump_version VERSION KIND -> version
bump_version() {
  local version="$1" kind="$2" major minor patch
  IFS=. read -r major minor patch <<<"$version"
  case "$kind" in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "$major.$((minor + 1)).0" ;;
    patch) echo "$major.$minor.$((patch + 1))" ;;
    *) echo "$version" ;;
  esac
}

# change_kind FROM TO -> none|patch|minor|major (how FROM differs from TO)
change_kind() {
  local from="$1" to="$2"
  if [ "$from" = "$to" ]; then echo none; return; fi
  local fm fmi fp tm tmi tp
  IFS=. read -r fm fmi fp <<<"$from"
  IFS=. read -r tm tmi tp <<<"$to"
  if [ "$fm" != "$tm" ]; then echo major; return; fi
  if [ "$fmi" != "$tmi" ]; then echo minor; return; fi
  echo patch
}

kind_rank() {
  case "$1" in none) echo 0 ;; patch) echo 1 ;; minor) echo 2 ;; major) echo 3 ;; esac
}

kind_label() {
  case "$1" in
    none) echo "nothing (see warning below)" ;;
    patch) echo "a **patch** bump" ;;
    minor) echo "a **minor** bump" ;;
    major) echo "a **major** bump" ;;
  esac
}

render_body() {
  local title="$1" body="$2" version="$3" kind="$4" class_line="$5" proposal="$6"
  local next_line changelog_line warn_lines=""
  if [ "$kind" = none ]; then
    next_line="no contribution"
  else
    next_line="\`v$version\` -> \`v$(bump_version "$version" "$kind")\`"
  fi
  if [ "$PARSED" = no ]; then
    class_line="**not a conventional commit**"
    changelog_line="missing"
  else
    if [ "$TYPE" = feat ] || [ "$TYPE" = fix ] || [ "$TYPE" = perf ] || [ "$TYPE" = revert ]; then
      changelog_line="shown"
    else
      changelog_line="hidden (type \`$TYPE\`)"
    fi
  fi
  if [ "$PARSED" = no ]; then
    warn_lines+=$'> :warning: **This PR title is not a conventional commit.** Merged as-is, release-please will not bump the version and this work will be missing from the changelog. Rename the PR title to `type(scope): summary` before merge.\n'
  elif ! grep -qw "$TYPE" <<<"$KNOWN_TYPES"; then
    warn_lines+=$"> :warning: **Unrecognized type \`$TYPE\`.** It parses and bumps the patch, but it has no changelog section, so the work will be missing from the changelog. Use one of: $KNOWN_TYPES.\n"
  fi
  cat <<EOF
$MARKER
## Version impact

| | |
|---|---|
| PR title | \`$title\` |
| Conventional commit | $class_line |
| Breaking change | $BREAKING |
| Current release | \`v$version\` |
| This PR contributes | $(kind_label "$kind") |
| Next release if this PR lands alone | $next_line |
| Changelog entry | $changelog_line |
| Standing release PR | $proposal |

The release version is cut when the standing release-please PR merges. It batches everything merged since the last release and takes the strongest bump in the batch, so this row is this PR's contribution, not the final number. While the project is pre-1.0, \`feat\` and \`fix\` bump the patch and a breaking change bumps the minor; from 1.0.0 on, \`feat\` bumps the minor and a breaking change the major.

Breaking changes must show as \`type(scope)!: summary\` or a \`BREAKING CHANGE: ...\` line in the PR body. Prose such as "Breaking changes" is invisible to release-please.

${warn_lines}
EOF
}

proposal_line() {
  local version="$1" kind="$2"
  local pr_title
  pr_title=$(gh pr list --repo "$GITHUB_REPOSITORY" --state open --json title \
    --jq '[.[] | select(.title | startswith("chore(main): release "))] | first | .title // empty')
  if [ -z "$pr_title" ]; then
    echo "none open yet; the next run opens one at \`v$(bump_version "$version" "$kind")\` for this bump"
    return
  fi
  local proposed="${pr_title##* }"
  local proposal_kind
  proposal_kind=$(change_kind "$version" "$proposed")
  if [ "$kind" != none ] && [ "$(kind_rank "$kind")" -gt "$(kind_rank "$proposal_kind")" ]; then
    echo "\`v$proposed\` open; this PR raises it to \`v$(bump_version "$version" "$kind")\`"
  else
    echo "\`v$proposed\` open; this PR does not change it"
  fi
}

run() {
  local root
  root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
  local version
  version=$(tr -d '[:space:]' < "$root/version.txt")
  classify "${PR_TITLE:?PR_TITLE is required}" "${PR_BODY:-}"
  local kind
  kind=$(contrib_kind "$version")
  local class_line
  if [ "$PARSED" = yes ]; then class_line="\`$TYPE\`"; else class_line="**not a conventional commit**"; fi
  local proposal
  proposal=$(proposal_line "$version" "$kind")
  local new_body existing_id existing_body payload
  new_body=$(render_body "${PR_TITLE}" "${PR_BODY:-}" "$version" "$kind" "$class_line" "$proposal")

  existing_id=$(gh api --paginate "repos/${GITHUB_REPOSITORY:?}/issues/${PR_NUMBER:?}/comments" \
    --jq ".[] | select(.user.login == \"github-actions[bot]\") | select(.body // \"\" | contains(\"$MARKER\")) | .id" | tail -n 1)
  if [ -n "$existing_id" ]; then
    existing_body=$(gh api "repos/$GITHUB_REPOSITORY/issues/comments/$existing_id" --jq .body)
    if [ "$existing_body" = "$new_body" ]; then
      echo "Version impact comment unchanged; not editing."
      return
    fi
  fi
  payload=$(jq -n --arg body "$new_body" '{body: $body}')
  if [ -n "$existing_id" ]; then
    gh api -X PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$existing_id" --input - <<<"$payload" >/dev/null
    echo "Updated version impact comment $existing_id."
  else
    gh api -X POST "repos/$GITHUB_REPOSITORY/issues/$PR_NUMBER/comments" --input - <<<"$payload" >/dev/null
    echo "Posted version impact comment."
  fi
}

self_test() {
  local failures=0
  # expect TITLE BODY VERSION EXP_PARSED EXP_TYPE EXP_BREAKING EXP_KIND
  expect() {
    local title="$1" body="$2" version="$3" e_parsed="$4" e_type="$5" e_breaking="$6" e_kind="$7"
    classify "$title" "$body"
    local kind
    kind=$(contrib_kind "$version")
    if [ "$PARSED" = "$e_parsed" ] && [ "$TYPE" = "$e_type" ] && [ "$BREAKING" = "$e_breaking" ] && [ "$kind" = "$e_kind" ]; then
      echo "ok   $title"
    else
      echo "FAIL $title: parsed=$PARSED/$e_parsed type=$TYPE/$e_type breaking=$BREAKING/$e_breaking kind=$kind/$e_kind"
      failures=$((failures + 1))
    fi
  }
  expect "fix: add restart policy to postgres" "" 0.2.0 yes fix no patch
  expect "feat(hosts): view and rotate a JWK" "" 0.2.0 yes feat no patch
  expect "feat(api)!: remove v1 endpoints" "" 0.2.0 yes feat yes minor
  expect "fix(api)!: drop the legacy scan" "" 0.2.0 yes fix yes minor
  expect "feat(api): remove v1 endpoints" $'text\n\nBREAKING CHANGE: v1 endpoints removed\n\nmore' 0.2.0 yes feat yes minor
  expect "feat(api): remove v1 endpoints" $'text\n\nBREAKING-CHANGE: v1 endpoints removed' 0.2.0 yes feat yes minor
  expect "feat(api): remove v1 endpoints" $'## Breaking changes\n\n- v1 endpoints removed' 0.2.0 yes feat no patch
  expect "feat(api): remove v1 endpoints" "Breaking change: v1 endpoints removed" 0.2.0 yes feat no patch
  expect "Make the comment style scan mechanical" "" 0.2.0 no "" no none
  expect "feat x" "" 0.2.0 no "" no none
  expect "chore(deps): bump zod from 4.5.4 to 4.6.5" "" 0.2.0 yes chore no patch
  expect "wip: experimental thing" "" 0.2.0 yes wip no patch
  expect "perf(monaco): import minimal editor core (#482)" "" 0.2.0 yes perf no patch
  expect "feat!: drop v1" "" 1.2.3 yes feat yes major
  expect "feat(api): add a view" "" 1.2.3 yes feat no minor
  expect "fix: repair the scan" "" 1.2.3 yes fix no patch
  [ "$failures" -eq 0 ] && echo "self-test: 16/16 passed"
  return "$failures"
}

case "${1:-}" in
  --self-test) self_test ;;
  *) run ;;
esac
